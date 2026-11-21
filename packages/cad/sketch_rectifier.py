"""Build a registration map and visual feature candidates. All coordinates here are image space."""

from __future__ import annotations

import io
import math
from contextlib import contextmanager
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 20 * 1024 * 1024
MAX_SIDE = 2200


def jpeg_with_gain_map(image):
    if image.format != "MPO" or image.n_frames != 2:
        return False
    # Phone HDR JPEGs may store a gain map as an auxiliary MPF image.
    # Only the primary image is the drawing. Reject stereo and arbitrary multi-view MPOs.
    entries = image.mpinfo.get(0xB002, [])
    if len(entries) != 2 or entries[0]["Attribute"]["MPType"] != "Baseline MP Primary Image":
        return False
    try:
        image.seek(1)
        xmp = image.info.get("xmp", b"")
        return (
            b"urn:com:apple:photo:2020:aux:hdrgainmap" in xmp
            or b"http://ns.adobe.com/hdr-gain-map/1.0/" in xmp
        )
    finally:
        image.seek(0)


def open_photo(data: bytes):
    if not 0 < len(data) <= MAX_BYTES:
        raise ValueError("Choose a photo of up to 20 MiB.")
    formats = ["JPEG", "PNG", "WEBP"]
    if data[4:8] == b"ftyp":
        from pillow_heif import register_heif_opener

        register_heif_opener()
        formats.append("HEIF")
    try:
        image = Image.open(io.BytesIO(data), formats=formats)
        if (
            min(image.size) < 32
            or image.width * image.height > 40_000_000
            or (getattr(image, "n_frames", 1) != 1 and not jpeg_with_gain_map(image))
        ):
            image.close()
            raise ValueError("Choose a single photo between 32 pixels per side and 40 megapixels.")
        return image
    except (UnidentifiedImageError, OSError, EOFError, Image.DecompressionBombError) as exc:
        raise ValueError("Choose a readable JPG, PNG, WebP or HEIC photo.") from exc


def image_format(data: bytes) -> str:
    with open_photo(data) as photo:
        return {"JPEG": "image/jpeg", "MPO": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "HEIF": "image/heic"}[
            photo.format
        ]


@contextmanager
def pdf_page(data: bytes):
    from .pdf_lock import pdfium_lock
    import pypdfium2 as pdfium

    try:
        with pdfium_lock, pdfium.PdfDocument(data) as document:
            if len(document) != 1:
                raise ValueError("Choose a one-page sketch PDF. Use Blueprint estimates for drawing sets.")
            page = document[0]
            try:
                size = page.get_size()
                if (not all(math.isfinite(value) and 0 < value < 100_000 for value in size)
                        or min(size) / max(size) < 32 / MAX_SIDE):
                    raise ValueError("The sketch PDF page has invalid dimensions.")
                yield page, size
            finally:
                page.close()
    except (RuntimeError, pdfium.PdfiumError, OSError):
        raise ValueError("Choose a readable, unlocked sketch PDF.") from None


@contextmanager
def scan_page(data: bytes):
    with pdf_page(data) as (page, size):
        bitmap = page.render(scale=MAX_SIDE / max(size))
        try:
            image = bitmap.to_pil().convert("RGB")
        finally:
            bitmap.close()
    with image:
        yield image


def sketch_format(data: bytes) -> str:
    if not data.startswith(b"%PDF-"):
        return image_format(data)
    if len(data) > MAX_BYTES:
        raise ValueError("Choose a file of up to 20 MiB.")
    with pdf_page(data):
        return "application/pdf"


@dataclass
class RectifiedSketch:
    photo: np.ndarray
    ink: np.ndarray
    overlay: np.ndarray
    registration: dict
    candidates: list[dict]

    def jpeg(self, annotated: bool = False) -> bytes:
        return self._jpeg(self.overlay if annotated else self.photo)

    def detail_views(self):
        height, width = self.photo.shape[:2]
        if max(width, height) < 1500:
            return
        x_overlap, y_overlap = width // 8, height // 8
        for vertical, y0, y1 in (("upper", 0, height // 2 + y_overlap), ("lower", height // 2 - y_overlap, height)):
            for horizontal, x0, x1 in (("left", 0, width // 2 + x_overlap), ("right", width // 2 - x_overlap, width)):
                yield f"{vertical} {horizontal}", self._jpeg(self.photo[y0:y1, x0:x1])

    @staticmethod
    def _jpeg(pixels) -> bytes:
        ok, encoded = cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            raise ValueError("Could not make the sketch preview.")
        return encoded.tobytes()


def ordered_quad(points):
    # Sort around the centroid; start at the top-left diagonal extremum.
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    center = points.mean(axis=0)
    order = np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))
    points = points[order]
    return np.roll(points, -np.argmin(points.sum(axis=1)), axis=0).copy()


def page_boundary(gray):
    h, w = gray.shape
    small = cv2.resize(
        gray, (max(1, round(w * min(1, 900 / max(h, w)))), max(1, round(h * min(1, 900 / max(h, w)))))
    )
    sh, sw = small.shape
    smooth = cv2.GaussianBlur(small, (7, 7), 0)
    _, white = cv2.threshold(smooth, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    edges = cv2.morphologyEx(cv2.Canny(smooth, 40, 120), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    choices = []
    for mask in (white, edges):
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
            fraction = cv2.contourArea(c) / (sw * sh)
            if not 0.32 < fraction < 0.995:
                continue
            quad = cv2.approxPolyDP(c, 0.023 * cv2.arcLength(c, True), True)
            if len(quad) != 4 or not cv2.isContourConvex(quad):
                continue
            p = ordered_quad(quad)
            vectors = np.roll(p, -1, axis=0) - p
            lengths = np.linalg.norm(vectors, axis=1)
            if min(lengths) < 0.18 * min(sw, sh):
                continue
            directions = vectors / lengths[:, None]
            if np.max(np.abs(np.sum(directions * np.roll(directions, 1, axis=0), axis=1))) > 0.72:
                continue
            # A rectangular inked part on white paper has a light exterior too.
            page = np.zeros_like(small)
            cv2.fillConvexPoly(page, quad, 255)
            inside = cv2.erode(page, np.ones((11, 11), np.uint8))
            ring = cv2.dilate(page, np.ones((13, 13), np.uint8)) - page
            if (
                cv2.countNonZero(ring) < 100
                or float(np.median(small[inside > 0])) - float(np.median(small[ring > 0])) < 14
            ):
                continue
            choices.append((fraction, p * np.array([w / sw, h / sh], np.float32)))
    return max(choices, key=lambda entry: entry[0])[1] if choices else None


def skew_angle(gray):
    h, w = gray.shape
    lines = cv2.HoughLinesP(
        cv2.Canny(gray, 55, 140),
        1,
        np.pi / 360,
        45,
        minLineLength=max(24, min(w, h) // 7),
        maxLineGap=max(4, min(w, h) // 100),
    )
    if lines is None:
        return 0.0
    votes = []
    for x, y, a, b in lines[:, 0]:
        angle = (math.degrees(math.atan2(b - y, a - x)) + 45) % 90 - 45
        if abs(angle) <= 12:
            votes.append((angle, math.hypot(b - y, a - x)))
    if len(votes) < 3:
        return 0.0
    votes.sort()
    median = votes[np.searchsorted(np.cumsum([n for _, n in votes]), sum(n for _, n in votes) / 2)][0]
    support = sum(n for v, n in votes if abs(v - median) < 2)
    return median if support >= 0.55 * sum(n for _, n in votes) and abs(median) > 0.3 else 0.0


def dash_chains(binary, outline):
    """Group separated ink strokes by common direction, line distance and repeated gaps."""
    x, y, w, h = cv2.boundingRect(outline)
    short = min(w, h)
    roi = np.zeros((h, w), np.uint8)
    cv2.drawContours(roi, [outline - np.array([[[x, y]]], dtype=np.int32)], -1, 255, -1)
    inset = max(5, round(short * 0.018))
    roi = cv2.erode(
        roi, np.ones((2 * inset + 1, 2 * inset + 1), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0
    )
    ink = cv2.bitwise_and(binary[y : y + h, x : x + w], roi)
    strokes = []
    contours, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if len(contours) > 12000:
        return []
    for c in contours:
        center, (a, b), angle = cv2.minAreaRect(c)
        length, width = max(a, b), max(1, min(a, b))
        if not 4 <= length <= 0.24 * max(w, h) or length / width < 2.6:
            continue
        theta = math.radians(angle + (90 if b > a else 0))
        direction = np.array([math.cos(theta), math.sin(theta)])
        strokes.append((np.array(center) + [x, y], direction, length))
    if len(strokes) > 450:
        return []
    used = set()
    chains = []
    for i, (origin, direction, length) in enumerate(strokes):
        if i in used:
            continue
        normal = np.array([-direction[1], direction[0]])
        group = []
        for j, (point, d, l) in enumerate(strokes):
            if j in used or abs(direction @ d) < 0.97 or not 0.45 < l / length < 2.2:
                continue
            if abs((point - origin) @ normal) <= max(3, 0.008 * short):
                t = float((point - origin) @ direction)
                group.append((t - l / 2, t + l / 2, j))
        group.sort()
        runs = []
        for piece in group:
            if not runs or not 0.10 * length <= piece[0] - runs[-1][-1][1] <= 2.8 * length:
                runs.append([])
            runs[-1].append(piece)
        for run in runs:
            if len(run) < 3 or run[-1][1] - run[0][0] < 0.16 * short:
                continue
            used.update(k for _, _, k in run)
            chains.append([origin + direction * run[0][0], origin + direction * run[-1][1]])
    return chains


def detect_features(binary):
    h, w = binary.shape

    def norm(p):
        return {
            key: round(min(1000, max(0, float(v) * 1000 / (size - 1))), 2)
            for key, v, size in (("x", p[0], w), ("y", p[1], h))
        }

    contours, tree = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    selected = []
    for index in sorted(range(len(contours)), key=lambda i: cv2.contourArea(contours[i]), reverse=True):
        contour = contours[index]
        area = cv2.contourArea(contour)
        if area < max(45, w * h * 0.00016):
            break
        x, y, cw, ch = cv2.boundingRect(contour)
        if area > 0.9 * w * h or min(cw, ch) < 8 or area / (cw * ch) < 0.18:
            continue
        # Collapse the two sides of an ink stroke before testing containment.
        parent_index = tree[0, index, 3]
        if parent_index >= 0:
            a, b, c, d = cv2.boundingRect(contours[parent_index])
            insets = (x - a, y - b, a + c - x - cw, b + d - y - ch)
            if min(insets) >= 0 and max(insets) <= max(5, 0.02 * min(cw, ch)) and min(cw / c, ch / d) > 0.65:
                continue
        parent = next(
            (
                ref
                for poly, _, ref, kind in selected
                if kind == "outer"
                and all(
                    cv2.pointPolygonTest(poly, (float(px), float(py)), False) >= 0
                    for px, py in contour[:: max(1, len(contour) // 16), 0]
                )
            ),
            None,
        )
        if parent is None and (area < 0.008 * w * h or min(cw, ch) < 0.055 * min(w, h)):
            continue
        kind = "hole" if parent else "outer"
        selected.append((contour, (x, y, cw, ch), f"C{len(selected) + 1}", kind))
        if len(selected) >= 100:
            break
    features = []
    for c, (x, y, cw, ch), ref, kind in selected:
        poly = cv2.approxPolyDP(c, 0.012 * cv2.arcLength(c, True), True)[:, 0]
        features.append(
            {
                "id": ref,
                "kind": kind,
                "anchor": norm((x + cw / 2, y + ch / 2)),
                "points": [norm(p) for p in poly[:48]],
            }
        )
    for c, _, ref, kind in selected:
        if kind == "outer":
            for a, b in dash_chains(binary, c)[:20]:
                features.append(
                    {
                        "id": f"D{len(features) + 1}",
                        "kind": "bend",
                        "anchor": norm((a + b) / 2),
                        "points": [norm(a), norm(b)],
                    }
                )
    return features


def exif_matrix(orientation, width, height):
    """Map raw image pixels to the upright display used by ImageOps.exif_transpose."""
    right, bottom = width - 1, height - 1
    axes = {
        2: ([-1, 0, right], [0, 1, 0]),
        3: ([-1, 0, right], [0, -1, bottom]),
        4: ([1, 0, 0], [0, -1, bottom]),
        5: ([0, 1, 0], [1, 0, 0]),
        6: ([0, -1, bottom], [1, 0, 0]),
        7: ([0, -1, bottom], [-1, 0, right]),
        8: ([0, 1, 0], [-1, 0, right]),
    }
    x, y = axes.get(orientation, ([1, 0, 0], [0, 1, 0]))
    return np.array([x, y, [0, 0, 1]], dtype=np.float64)


def rectify_sketch(data: bytes) -> RectifiedSketch:
    source = scan_page(data) if data.startswith(b"%PDF-") else open_photo(data)
    with source as photo:
        raw_size = photo.size
        orientation = photo.getexif().get(274, 1)
        upright = exif_matrix(orientation, *raw_size)
        rgba = ImageOps.exif_transpose(photo).convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        ow, oh = background.size
        background.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        image = cv2.cvtColor(np.asarray(background), cv2.COLOR_RGB2BGR)
    h, w = image.shape[:2]
    transform = np.diag([(w - 1) / (ow - 1), (h - 1) / (oh - 1), 1.0]) @ upright
    corners = page_boundary(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    detected = corners is not None
    if detected:
        a, b, c, d = corners
        nw = round(max(np.linalg.norm(a - b), np.linalg.norm(d - c))) + 1
        nh = round(max(np.linalg.norm(a - d), np.linalg.norm(b - c))) + 1
        dest = np.float32([[0, 0], [nw - 1, 0], [nw - 1, nh - 1], [0, nh - 1]])
        warp = cv2.getPerspectiveTransform(corners, dest)
        image = cv2.warpPerspective(image, warp, (nw, nh), borderValue=(255, 255, 255))
        original_corners = cv2.perspectiveTransform(corners[None], np.linalg.inv(transform))[0].tolist()
        transform = warp @ transform
    else:
        original_corners = None
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    angle = skew_angle(gray)
    if angle:
        h, w = gray.shape
        spin = cv2.getRotationMatrix2D(((w - 1) / 2, (h - 1) / 2), angle, 1)
        nw = math.ceil(h * abs(spin[0, 1]) + w * abs(spin[0, 0]))
        nh = math.ceil(w * abs(spin[0, 1]) + h * abs(spin[0, 0]))
        spin[:, 2] += [(nw - w) / 2, (nh - h) / 2]
        image = cv2.warpAffine(image, spin, (nw, nh), borderValue=(255, 255, 255))
        transform = np.vstack((spin, [0, 0, 1])) @ transform
    gray = cv2.medianBlur(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), 3)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 10)
    features = detect_features(binary)
    h, w = gray.shape
    overlay = image.copy()
    colors = {"outer": (90, 110, 5), "hole": (155, 60, 45), "bend": (0, 100, 190)}
    for item in features:
        pts = np.int32([[p["x"] * (w - 1) / 1000, p["y"] * (h - 1) / 1000] for p in item["points"]])
        if len(pts) > 1:
            cv2.polylines(overlay, [pts], item["kind"] != "bend", colors[item["kind"]], 2)
            x, y = pts[0]
            cv2.putText(
                overlay, item["id"], (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colors[item["kind"]], 2
            )
    registration = {
        "original_size": list(raw_size),
        "display_size": [ow, oh],
        "exif_orientation": orientation,
        "size": [w, h],
        "page_detected": detected,
        "page_corners": original_corners,
        "deskew_deg": angle,
        "photo_to_page": transform.tolist(),
    }
    return RectifiedSketch(image, binary, overlay, registration, features)
