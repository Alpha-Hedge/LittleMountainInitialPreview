"""Produce a high-contrast reading copy. Pixel coordinates stay outside the CAD model."""

from __future__ import annotations

from io import BytesIO
from math import dist

import cv2
import numpy as np
from PIL import Image, ImageOps
from shapely.geometry import Polygon


def reading_copy(photo: bytes, page_corners=None) -> bytes:
    """Page corners, if supplied, are TL, TR, BR, BL pixels after EXIF orientation."""
    if len(photo) > 20 * 1024 * 1024:
        raise ValueError("Image exceeds 20 MiB.")
    with Image.open(BytesIO(photo), formats=["JPEG", "PNG", "WEBP"]) as image:
        if image.width * image.height > 40_000_000 or min(image.size) < 20:
            raise ValueError("Choose a photo between 20 pixels per side and 40 megapixels.")
        if getattr(image, "is_animated", False):
            raise ValueError("Choose a single still image.")
        oriented = ImageOps.exif_transpose(image).convert("RGBA")
        white = Image.new("RGBA", oriented.size, "white")
        white.alpha_composite(oriented)
        gray = np.asarray(white.convert("L"))
    h, w = gray.shape
    if page_corners is not None:
        pts = np.array(page_corners, dtype=np.float32)
        if pts.shape != (4, 2) or not np.isfinite(pts).all():
            raise ValueError("Choose four finite page corners.")
        if (
            pts[:, 0].min() < 0
            or pts[:, 1].min() < 0
            or pts[:, 0].max() >= w
            or pts[:, 1].max() >= h
        ):
            raise ValueError("Page corners must be inside the oriented photograph.")
        boundary = Polygon(pts)
        if (
            not boundary.is_valid
            or not boundary.exterior.is_ccw
            or not boundary.equals(boundary.convex_hull)
            or boundary.area < 100
        ):
            raise ValueError("Choose the four page corners clockwise from the top left.")
        target_w = max(dist(pts[0], pts[1]), dist(pts[3], pts[2]))
        target_h = max(dist(pts[0], pts[3]), dist(pts[1], pts[2]))
        resize = min(1, 3200 / max(target_w, target_h))
        width, height = round(target_w * resize), round(target_h * resize)
        if min(width, height) < 20:
            raise ValueError("Selected page is too narrow to read.")
        target = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
        transform = cv2.getPerspectiveTransform(pts, target)
        gray = cv2.warpPerspective(gray, transform, (width, height), borderValue=255)
    elif max(h, w) > 3200:
        scale = 3200 / max(h, w)
        gray = cv2.resize(
            gray, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA
        )
    block = min(51, ((min(gray.shape) - 1) // 2) * 2 + 1)
    if block < 3:
        raise ValueError("The reading copy is too narrow.")
    output = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 11
    )
    success, png = cv2.imencode(".png", output)
    if not success:
        raise ValueError("Reading copy could not be encoded.")
    return png.tobytes()
