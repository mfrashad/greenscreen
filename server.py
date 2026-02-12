"""FastAPI web server for green screen replacement tool."""

import base64
import json
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

import greenscreen

app = FastAPI(title="Green Screen Replacement")

MAX_PREVIEW_WIDTH = 1200


def decode_upload(file_bytes):
    """Decode uploaded image bytes to numpy array."""
    arr = np.frombuffer(file_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img


def encode_image(img, fmt=".png"):
    """Encode numpy array to bytes."""
    _, buf = cv2.imencode(fmt, img)
    return buf.tobytes()


def resize_for_preview(img, max_width=MAX_PREVIEW_WIDTH):
    """Resize image if wider than max_width, return (resized, scale)."""
    h, w = img.shape[:2]
    if w <= max_width:
        return img, 1.0
    scale = max_width / w
    new_w, new_h = int(w * scale), int(h * scale)
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA), scale


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join("static", "index.html")) as f:
        return f.read()


@app.get("/api/templates")
async def templates():
    """Return predefined template list with pre-detected corners."""
    path = os.path.join("static", "templates", "corners.json")
    with open(path) as f:
        return json.load(f)


@app.post("/api/detect")
async def detect(base: UploadFile = File(...)):
    """Upload base image, return detected corners and preview."""
    base_img = decode_upload(await base.read())
    corners = greenscreen.detect_from_array(base_img)

    preview, scale = resize_for_preview(base_img)
    preview_b64 = base64.b64encode(encode_image(preview, ".jpg")).decode()

    return {
        "corners": corners.tolist(),
        "image": preview_b64,
        "width": base_img.shape[1],
        "height": base_img.shape[0],
        "preview_scale": scale,
    }


@app.post("/api/preview")
async def preview(
    base: UploadFile = File(...),
    screenshot: UploadFile = File(...),
    corners: str = Form(...),
    brightness: float = Form(0),
    contrast: float = Form(0),
    temperature: float = Form(0),
):
    """Generate preview with given parameters."""
    base_img = decode_upload(await base.read())
    ss_img = decode_upload(await screenshot.read())

    corner_pts = np.array(json.loads(corners), dtype=np.float32)

    result = greenscreen.process_from_arrays(
        base_img, ss_img, corners=corner_pts,
        brightness=brightness, contrast=contrast, temperature=temperature,
    )

    preview, _ = resize_for_preview(result)
    result_b64 = base64.b64encode(encode_image(preview, ".jpg")).decode()
    return {"image": result_b64}


@app.post("/api/process-one")
async def process_one(
    base: UploadFile = File(...),
    screenshot: UploadFile = File(...),
    corners: str = Form(...),
    brightness: float = Form(0),
    contrast: float = Form(0),
    temperature: float = Form(0),
):
    """Process a single screenshot at full resolution, return PNG."""
    base_img = decode_upload(await base.read())
    ss_img = decode_upload(await screenshot.read())

    corner_pts = np.array(json.loads(corners), dtype=np.float32)

    result = greenscreen.process_from_arrays(
        base_img, ss_img, corners=corner_pts,
        brightness=brightness, contrast=contrast, temperature=temperature,
    )

    result_bytes = encode_image(result, ".png")
    raw_name = os.path.splitext(screenshot.filename or "screenshot")[0]
    # Sanitize filename to ASCII-safe characters for Content-Disposition header
    safe_name = raw_name.encode("ascii", "ignore").decode("ascii").strip() or "screenshot"
    return Response(
        content=result_bytes,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}_composite.png"'},
    )


app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
