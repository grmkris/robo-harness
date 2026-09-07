"""GPU worker contract, usable on RunPod or behind a compatible hosted adapter."""

import argparse
import base64
import hmac
import io
import os
import tempfile
import threading
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel, Field


def png(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return base64.b64encode(output.getvalue()).decode()


class Inference(BaseModel):
    kind: str
    prompt: str = Field(default="object", max_length=200)
    frame: dict


class Models:
    def __init__(self):
        self.segment = None
        self.depth = None
        self.lock = threading.Lock()

    def infer(self, request):
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("This worker requires a CUDA GPU; no silent CPU fallback")
        frame = request.frame
        raw = base64.b64decode(frame["base64"], validate=True)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError("Input image is too large")
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        if max(image.size) > 2048:
            raise ValueError("Input resolution exceeds worker limit")
        base = {"frame_id": frame["id"], "kind": request.kind, "width": image.width, "height": image.height}
        with self.lock, torch.inference_mode():
            if request.kind == "segment":
                from sam3.model.sam3_image_processor import Sam3Processor
                from sam3.model_builder import build_sam3_image_model

                checkpoint = os.environ.get("SAM3_CHECKPOINT")
                if not checkpoint:
                    raise ValueError("SAM3_CHECKPOINT must identify pre-downloaded, versioned weights")
                if self.segment is None:
                    self.segment = Sam3Processor(build_sam3_image_model(checkpoint_path=checkpoint))
                state = self.segment.set_image(image)
                result = self.segment.set_text_prompt(state=state, prompt=request.prompt)
                masks = result["masks"].detach().cpu().numpy()
                scores = result["scores"].detach().cpu().numpy()
                overlay = np.array(image).copy()
                output = []
                for mask, score in zip(masks[:16], scores[:16]):
                    mask = np.squeeze(mask) > 0.5
                    overlay[mask] = (overlay[mask] * 0.5 + np.array([120, 210, 160]) * 0.5).astype(np.uint8)
                    output.append(
                        {
                            "png": png(Image.fromarray(mask.astype(np.uint8) * 255)),
                            "label": request.prompt,
                            "score": float(score),
                        }
                    )
                return {
                    **base,
                    "model": "SAM 3",
                    "model_version": Path(checkpoint).name,
                    "preview_png": png(Image.fromarray(overlay)),
                    "masks": output,
                    "units": "pixels",
                }
            if request.kind == "depth":
                from depth_anything_3.api import DepthAnything3

                checkpoint = os.environ.get("DA3_CHECKPOINT")
                if not checkpoint:
                    raise ValueError(
                        "DA3_CHECKPOINT must identify a pre-downloaded, versioned model directory"
                    )
                if self.depth is None:
                    self.depth = DepthAnything3.from_pretrained(checkpoint).to(device="cuda")
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "input.png"
                    image.save(path)
                    result = self.depth.inference([str(path)])
                depth = np.asarray(result.depth[0], dtype=np.float32)
                if not np.all(np.isfinite(depth)):
                    raise ValueError("Depth model produced non-finite values")
                # Align output to input pixels; relative scale is preserved and explicitly labeled.
                depth = np.array(Image.fromarray(depth).resize(image.size, Image.Resampling.BILINEAR))
                lo, hi = np.percentile(depth, [2, 98])
                gray = (np.clip((depth - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)
                small = np.array(Image.fromarray(depth).resize((160, 120), Image.Resampling.BILINEAR))
                return {
                    **base,
                    "model": "Depth Anything 3",
                    "model_version": Path(checkpoint).name,
                    "preview_png": png(Image.fromarray(gray)),
                    "depth": small.tolist(),
                    "depth_width": 160,
                    "depth_height": 120,
                    "depth_to_image": [[image.width / 160, 0, 0], [0, image.height / 120, 0], [0, 0, 1]],
                    "units": "relative",
                }
            raise ValueError("Unknown perception capability")


def create_app():
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    token = os.environ.get("ROBO_PERCEPTION_TOKEN", "")
    if len(token) < 24:
        raise ValueError("ROBO_PERCEPTION_TOKEN must have at least 24 characters")
    models = Models()

    @app.middleware("http")
    async def auth(req: Request, next):
        if not hmac.compare_digest(req.headers.get("authorization", ""), "Bearer " + token):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return await next(req)

    @app.post("/infer")
    def infer(request: Inference):
        try:
            return models.infer(request)
        except ValueError as e:
            # Bad client input (oversized or malformed image — binascii.Error is
            # a ValueError) is the caller's fault.
            return JSONResponse({"error": str(e)}, status_code=422)
        except Exception as e:
            # A missing GPU, a model load failure or OOM is the worker's fault,
            # not the caller's: report it as a server error, not a 422.
            return JSONResponse({"error": str(e)}, status_code=500)

    return app


def main():
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    uvicorn.run(create_app(), host=args.host, port=args.port, access_log=False)
