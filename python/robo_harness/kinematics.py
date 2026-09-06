"""URDF FK and position-only IK. Gripper percent never enters arm-angle FK."""

import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

ARM_JOINTS = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll")
JOINTS = (*ARM_JOINTS, "gripper")


class Kinematics:
    def __init__(self, path: str, offsets: dict | None = None):
        root = ET.parse(Path(path)).getroot()
        self.joints = list(root.findall("joint"))
        self.offsets = offsets or {}

    def frames(self, angles: dict) -> dict:
        frames = {"base_link": np.eye(4)}
        pending = self.joints.copy()
        while pending:
            progressed = False
            for joint in pending[:]:
                parent = joint.find("parent").attrib["link"]
                if parent not in frames:
                    continue
                origin = joint.find("origin")
                t = np.eye(4)
                if origin is not None:
                    t[:3, 3] = np.fromstring(origin.get("xyz", "0 0 0"), sep=" ")
                    t[:3, :3] = Rotation.from_euler(
                        "xyz", np.fromstring(origin.get("rpy", "0 0 0"), sep=" ")
                    ).as_matrix()
                name = joint.get("name")
                if joint.get("type") in ("revolute", "continuous") and name != "gripper":
                    axis = np.fromstring(joint.find("axis").get("xyz"), sep=" ")
                    turn = np.eye(4)
                    turn[:3, :3] = Rotation.from_rotvec(
                        axis * np.deg2rad(angles.get(name, 0) + self.offsets.get(name, 0))
                    ).as_matrix()
                    t = t @ turn
                frames[joint.find("child").get("link")] = frames[parent] @ t
                pending.remove(joint)
                progressed = True
            if not progressed:
                raise ValueError("URDF has an unresolved frame graph")
        return frames

    def xyz(self, angles: dict) -> np.ndarray:
        return self.frames(angles)["gripper_frame_link"][:3, 3]

    def inverse(self, current: dict, target: list, limits: dict) -> dict:
        start = np.array([current[j] for j in ARM_JOINTS])
        target = np.asarray(target, dtype=float)

        def residual(q):
            pose = {**current, **dict(zip(ARM_JOINTS, q))}
            return np.concatenate(((self.xyz(pose) - target) * 100, (q - start) * 0.0001))

        solved = least_squares(
            residual,
            start,
            bounds=([limits[j][0] for j in ARM_JOINTS], [limits[j][1] for j in ARM_JOINTS]),
            max_nfev=120,
        )
        out = {**current, **dict(zip(ARM_JOINTS, solved.x.tolist()))}
        if np.linalg.norm(self.xyz(out) - target) > 0.003:
            raise ValueError("Cartesian target is unreachable within 3 mm")
        return out

    def validate(self, angles: dict, profile: dict):
        frames = self.frames(angles)
        ee = self.xyz(angles)
        if np.any(ee < profile["workspace_min"]) or np.any(ee > profile["workspace_max"]):
            raise ValueError("End effector is outside the commissioned workspace")
        radius = profile.get("link_radius_m", 0.015)
        for joint in self.joints:
            parent, child = joint.find("parent").get("link"), joint.find("child").get("link")
            a, b = frames[parent][:3, 3], frames[child][:3, 3]
            if parent != "base_link" and min(a[2], b[2]) - radius < profile["table_z_m"]:
                raise ValueError("Arm geometry intersects the configured table clearance")
            for box in profile.get("keepout_boxes", []):
                lo, hi = np.array(box["min"]) - radius, np.array(box["max"]) + radius
                # Segment/AABB slab test covers the complete link, including vertical links.
                tmin, tmax = 0.0, 1.0
                for k in range(3):
                    delta = b[k] - a[k]
                    if abs(delta) < 1e-12:
                        if a[k] < lo[k] or a[k] > hi[k]:
                            tmin, tmax = 1.0, 0.0
                            break
                    else:
                        u, v = sorted(((lo[k] - a[k]) / delta, (hi[k] - a[k]) / delta))
                        tmin, tmax = max(tmin, u), min(tmax, v)
                if tmin <= tmax:
                    raise ValueError("Arm geometry intersects a configured keep-out box")
