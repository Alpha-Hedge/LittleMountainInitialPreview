"""Bounded JSON stdio entry point for a confirmed drawing from the web workspace."""

from __future__ import annotations

import base64
import json
import sys

from pydantic import ValidationError

from .dxf_compiler import INNER, OUTER, compile_drawing, make_csv, make_dxf
from .geometry import solve_part
from .schema import Drawing
from .shop_sheet import make_pdf


def from_sketch(draft, revision=None):
    if not isinstance(draft, dict) or not isinstance(draft.get("parts"), list):
        raise TypeError("Choose a drawing with at least one part.")
    if draft.get("units") not in {"in", "mm"}:
        raise ValueError("Choose inches or millimeters.")
    if revision is not None and (type(revision) is not int or revision < 1):
        raise ValueError("Choose a valid drawing revision.")
    parts = []
    for i, p in enumerate(draft["parts"], 1):
        o = p["outline"]
        if o["kind"] == "rectangle":
            outline = {
                "kind": o["kind"],
                "width": o["width"],
                "height": o["height"],
                "corner_radius": o["cornerRadius"],
            }
        elif o["kind"] == "polygon":
            outline = {"kind": o["kind"], "vertices": o["vertices"]}
        else:
            raise ValueError(f"Choose the outline and finish dimensioning part {i}.")
        holes = []
        for h in p["holes"]:
            match h["shape"]:
                case "round":
                    fields = {"diameter": h["diameter"]}
                case "slot":
                    fields = {k: h[k] for k in ("width", "length", "angle")}
                case _:
                    raise ValueError(f"Unsupported opening in part {i}.")
            holes.append(
                {"shape": h["shape"], "center": {"x": h["centerX"], "y": h["centerY"]}, **fields}
            )
        parts.append(
            {
                "part_id": f"P{i:03}",
                "name": p["name"],
                "quantity": p["quantity"],
                "material": p["material"],
                "thickness": p["thickness"],
                "notes": p["notes"],
                "outline": outline,
                "holes": holes,
                "bends": p.get("bendLines", []),
            }
        )
    return Drawing.model_validate(
        {
            "title": draft["title"],
            "units": draft["units"],
            "revision": str(revision) if revision is not None else "Working",
            "parts": parts,
        }
    )


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def process(request):
    drawing = from_sketch(request["draft"], request.get("revision"))
    mode = request["format"]
    if mode == "bundle":
        bundle = compile_drawing(drawing)
        return {
            "pdf": encoded(bundle.pdf),
            "csv": encoded(bundle.csv),
            "dxfs": list(map(encoded, bundle.dxfs)),
            "partPages": bundle.part_pages,
        }
    gs = [solve_part(p) for p in drawing.parts]
    if mode == "preview":
        return {
            "units": drawing.units,
            "parts": [
                {
                    "bounds": g.bounds,
                    "contours": [
                        {"layer": OUTER, "vertices": g.outer},
                        *({"layer": INNER, "vertices": h.loop} for h in g.inner),
                    ],
                    "bends": [b.model_dump() for b in g.part.bends],
                }
                for g in gs
            ],
        }
    pages = []
    match mode:
        case "validate":
            data = b""
        case "dxf":
            part = request.get("part")
            if type(part) is not int or not 0 <= part < len(gs):
                raise ValueError("Choose a valid part.")
            data = make_dxf(drawing, gs[part])
        case "pdf":
            data, pages = make_pdf(drawing, gs)
        case "csv":
            data = make_csv(drawing, gs)
        case _:
            raise ValueError("Choose a supported drawing format.")
    return {"content": encoded(data), "partPages": pages}


def main():
    try:
        raw = sys.stdin.buffer.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Drawing exceeds the compiler input limit.")
        result = process(json.loads(raw))
    except ValidationError as exc:
        first = exc.errors(include_input=False, include_url=False)[0]
        location = ".".join(map(str, first["loc"]))
        print(f"{location}: {first['msg']}", file=sys.stderr)
        return 2
    except (KeyError, TypeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    sys.stdout.buffer.write(
        json.dumps(result, allow_nan=False, separators=(",", ":")).encode("utf-8")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
