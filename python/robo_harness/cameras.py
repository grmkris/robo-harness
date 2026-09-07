"""Latest-frame camera ownership; encoding and capture never run on the motor thread."""

import base64
import fcntl
import io
import threading
import time
from collections import OrderedDict

from PIL import Image, ImageDraw


class Cameras:
    def __init__(self, profile, domain):
        self.profile, self.domain = profile, domain
        self.lock = threading.Lock()
        self.frames, self.history, self.errors = {}, OrderedDict(), {}
        self.closed = threading.Event()
        self.seq = {"workspace": 0, "wrist": 0}
        self._file = None
        self.owner = None
        if profile["camera_mode"] == "lab":
            from lab_cameras import CameraOwner

            self.owner = CameraOwner(
                cameras=profile["camera_devices"],
                mode="robo-harness",
                session_path=profile.get("camera_session_path"),
            ).__enter__()
        if profile["camera_mode"] == "devices":
            # Same lock as SO101-lab. Existing labcam-preview must be stopped at reviewed deployment.
            self._file = open("/run/lock/lab-cams.lock", "a")
            fcntl.flock(self._file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.threads = [
            threading.Thread(target=self._capture, args=(name,), daemon=True, name=f"camera-{name}")
            for name in self.seq
        ]
        for t in self.threads:
            t.start()

    def _capture_lab(self, name):
        while not self.closed.wait(0.025):
            try:
                source = self.owner.latest(name, max_age_ms=500)
                if source.seq == self.seq[name]:
                    continue
                frame = {
                    "id": f"{self.domain}:{name}:{source.seq}",
                    "camera": name,
                    "seq": source.seq,
                    "monotonic_s": source.mono_ts,
                    "wall_time_ms": source.wall_ts * 1000,
                    "clock_domain": self.domain,
                    "width": source.bgr.shape[1],
                    "height": source.bgr.shape[0],
                    "media_type": "image/jpeg",
                    "base64": base64.b64encode(source.jpeg(quality=80)).decode(),
                    "repeat": source.repeat,
                    "calibration": self.profile.get("camera_calibrations", {}).get(name),
                }
                with self.lock:
                    self.seq[name] = source.seq
                    self.frames[name] = frame
                    self.history[frame["id"]] = frame
                    while len(self.history) > 240:
                        self.history.popitem(last=False)
                    self.errors.pop(name, None)
            except Exception as e:
                with self.lock:
                    self.errors[name] = str(e)
                self.closed.wait(0.1)

    def _open_device(self, name):
        import cv2

        cap = cv2.VideoCapture(self.profile["camera_devices"][name], cv2.CAP_V4L2)
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS, 30)
        if not cap.isOpened():
            cap.release()
            raise RuntimeError("Camera device could not be opened")
        # so101-lab rule: the device must actually deliver MJPG. A camera that
        # silently fell back to raw YUYV blows the USB bandwidth budget and
        # starves the other camera; refuse it rather than stream degraded.
        fourcc = int(cap.get(cv2.CAP_PROP_FOURCC))
        got = bytes((fourcc >> (8 * i)) & 0xFF for i in range(4)).decode("ascii", "replace")
        if got != "MJPG":
            cap.release()
            raise RuntimeError(f"Camera did not accept MJPG (reported {got!r})")
        return cap

    def _capture(self, name):
        if self.owner is not None:
            self._capture_lab(name)
            return
        cap = None
        mode = self.profile["camera_mode"]
        if mode not in ("devices", "mock"):
            with self.lock:
                self.errors[name] = "Unknown camera mode"
            return
        try:
            while not self.closed.is_set():
                if mode == "devices":
                    if cap is None:
                        try:
                            cap = self._open_device(name)
                        except Exception as e:
                            # A device that will not open is recoverable: record
                            # it and retry, rather than ending the thread.
                            with self.lock:
                                self.errors[name] = str(e)
                            self.closed.wait(1.0)
                            continue
                    import cv2

                    ok, bgr = cap.read()
                    mono, wall = time.monotonic(), time.time() * 1000
                    if not ok:
                        # A read failure is recoverable too: drop the handle and
                        # reopen on the next pass instead of killing the thread.
                        with self.lock:
                            self.errors[name] = "Camera read failed; reopening"
                        cap.release()
                        cap = None
                        self.closed.wait(0.5)
                        continue
                    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                    img = Image.fromarray(rgb)
                else:
                    self.closed.wait(0.1)
                    mono, wall = time.monotonic(), time.time() * 1000
                    img = Image.new("RGB", (640, 480), (30, 40, 36))
                    draw = ImageDraw.Draw(img)
                    for x in range(0, 640, 40):
                        draw.line((x, 0, x, 480), fill=(50, 63, 56))
                    for y in range(0, 480, 40):
                        draw.line((0, y, 640, y), fill=(50, 63, 56))
                    draw.rounded_rectangle((100, 210, 240, 370), radius=8, outline=(165, 185, 165), width=4)
                    draw.rounded_rectangle((310, 240, 355, 278), radius=6, fill=(225, 226, 214))
                    draw.line((520, 80, 470, 150, 380, 200, 370, 250), fill=(224, 172, 74), width=18)
                    draw.text((20, 18), f"SIMULATED / {name.upper()}", fill=(224, 172, 74))
                    draw.text(
                        (20, 445),
                        time.strftime("%H:%M:%S") + "  Synthetic camera fixture",
                        fill=(180, 195, 181),
                    )
                data = io.BytesIO()
                img.save(data, format="JPEG", quality=80)
                self.seq[name] += 1
                frame = {
                    "id": f"{self.domain}:{name}:{self.seq[name]}",
                    "camera": name,
                    "seq": self.seq[name],
                    "monotonic_s": mono,
                    "wall_time_ms": wall,
                    "clock_domain": self.domain,
                    "width": img.width,
                    "height": img.height,
                    "media_type": "image/jpeg",
                    "base64": base64.b64encode(data.getvalue()).decode(),
                    "calibration": self.profile.get("camera_calibrations", {}).get(name),
                }
                with self.lock:
                    self.frames[name] = frame
                    self.history[frame["id"]] = frame
                    while len(self.history) > 240:
                        self.history.popitem(last=False)
                    self.errors.pop(name, None)
        except Exception as e:
            with self.lock:
                self.errors[name] = str(e)
        finally:
            if cap:
                cap.release()

    def get(self, name, frame_id=None):
        with self.lock:
            f = self.history.get(frame_id) if frame_id else self.frames.get(name)
            if not f or f["camera"] != name:
                raise ValueError("Camera frame is unavailable or has expired")
            out = {**f, "age_ms": (time.monotonic() - f["monotonic_s"]) * 1000}
        if not frame_id and out["age_ms"] > 500:
            raise ValueError("Camera is stale")
        return out

    def status(self):
        with self.lock:
            return {
                name: {
                    "seq": self.seq[name],
                    "age_ms": None
                    if name not in self.frames
                    else (time.monotonic() - self.frames[name]["monotonic_s"]) * 1000,
                    "error": self.errors.get(name),
                }
                for name in self.seq
            }

    def close(self):
        self.closed.set()
        for t in self.threads:
            t.join(timeout=2)
        if self.owner is not None:
            self.owner.close()
        if self._file:
            self._file.close()
