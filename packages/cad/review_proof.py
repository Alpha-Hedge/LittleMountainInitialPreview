"""Read-only review compiles. Machine files are audited in memory; releases use the saved revision."""

import base64
import hashlib
from decimal import Decimal
from types import SimpleNamespace

from packages.cad.constraint_solver import solve_sketch
from packages.cad.cost_engine import bend_geometry, flat_geometry
from packages.cad.dxf_compiler import compile_drawing
from packages.cad.geometry import sampled, solve_part
from packages.cad.schema import Drawing, Part


def rectangular_views(jpeg):
    """Display registration hints only. CAD dimensions never come from these pixels."""
    import cv2
    import numpy as np

    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    h, w = image.shape
    mask = cv2.threshold(image, 150, 255, cv2.THRESH_BINARY_INV)[1]
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    result = []
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        area = bw * bh
        if not 0.012 * h * w < area < 0.83 * h * w or bw < 25 or bh < 25:
            continue
        if cv2.contourArea(c) < 0.96 * area:
            continue
        if len(cv2.approxPolyDP(c, 0.008 * cv2.arcLength(c, True), True)) != 4:
            continue
        result.append(
            [
                round(1000 * x / w, 2),
                round(1000 * y / h, 2),
                round(1000 * (x + bw) / w, 2),
                round(1000 * (y + bh) / h, 2),
                round(bw / bh, 4),
            ]
        )
    return result[:24]


def blank(messages):
    return {"geometry": [], "issues": messages, "pdf": None, "dxfs": []}


def proof(drawing, warnings=()):
    review = drawing.model_copy(
        update={"title": ("REVIEW COPY | " + drawing.title)[:120]}
    )
    files = compile_drawing(review)
    shapes = []
    for part in drawing.parts:
        geom = solve_part(part)
        outline = part.outline
        controls = (
            [v.xy for v in outline.vertices]
            if outline.kind == "polygon"
            else [
                (0, 0),
                (outline.width, 0),
                (outline.width, outline.height),
                (0, outline.height),
            ]
        )
        paths = [{"kind": "outer", "points": sampled(geom.outer)}]
        paths.extend({"kind": "hole", "points": sampled(h.loop)} for h in geom.inner)
        paths.extend(
            {"kind": "bend", "points": [b.start.xy, b.end.xy]} for b in part.bends
        )
        shapes.append(
            {
                "id": part.part_id,
                "controls": controls,
                "bounds": geom.bounds,
                "paths": paths,
            }
        )
    return {
        "geometry": shapes,
        "issues": list(warnings),
        "pdf": base64.b64encode(files.pdf).decode("ascii"),
        "dxfs": [
            {
                "part": p.part_id,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            for p, data in zip(drawing.parts, files.dxfs)
        ],
    }


def sketch_proof(reading, version, evidence, accepted):
    options = {
        "revision": version,
        "candidates": evidence["candidates"],
        "accepted": accepted,
    }
    result = solve_sketch(reading, evidence["registration"]["size"], **options)
    warnings = [p.message for p in result.pins]
    if result.pins and all(
        p.code == "low_confidence" and p.review_key for p in result.pins
    ):
        options["accepted"] = list(accepted) + [p.review_key for p in result.pins]
        result = solve_sketch(reading, evidence["registration"]["size"], **options)
    return proof(result.drawing, warnings) if result.drawing else blank(warnings)


def blueprint_drawing(ast, settings, title, version):
    parts = []
    for part in ast.parts:
        if part.stock_form not in (None, "plate", "sheet"):
            raise ValueError(f"{part.part_id} is a section or assembly. Supply an issued, dimensioned flat part.")
        if (
            not part.thickness_in
            or not (part.material_grade or part.material_family)
            or not part.quantity
        ):
            raise ValueError(
                part.part_id + " needs a material, thickness and quantity."
            )
        if part.dimension_basis == "unknown":
            raise ValueError(part.part_id + " needs the flat blank dimension basis.")
        stock = SimpleNamespace(
            spec_code=part.material_grade or part.material_family,
            thickness_in=part.thickness_in,
        )
        deduction = Decimal(0)
        if part.dimension_basis == "outside_flange_sum":
            stock = next(
                (
                    s
                    for s in settings.materials
                    if s.match_key()
                    == (
                        (part.material_family or "").casefold(),
                        (part.material_grade or "").casefold(),
                        Decimal(str(part.thickness_in)),
                    )
                ),
                None,
            )
            if stock is None or not part.bends:
                raise ValueError(
                    "Confirm the material bend schedule and dimensioned flat pattern."
                )
            deduction = sum(bend_geometry(b, stock)[1] * b.count for b in part.bends)
        geom = flat_geometry(part, stock, deduction)
        bends = []
        for i, b in enumerate(part.bends, 1):
            if b.count != 1 or b.start_in is None or b.end_in is None:
                raise ValueError(
                    f"{part.part_id} bend {i} needs both dimensioned flat endpoints."
                )
            supported={key for e in b.evidence for key in e.fields}
            if not {"start_in","end_in"} <= supported:
                raise ValueError(f"Confirm the written start and end dimensions for {part.part_id} bend {i}.")
            bends.append(
                {
                    "start": b.start_in.model_dump(),
                    "end": b.end_in.model_dump(),
                    "label": f"Bend {i}",
                    "angle": b.angle_deg,
                }
            )
        notes = list(part.requirements)
        if part.finish:
            notes.append("Finish: " + part.finish)
        for i, weld in enumerate(part.welds, 1):
            values = weld.model_dump(
                exclude={
                    "confidence",
                    "issues",
                    "evidence",
                    "page_anchor",
                    "field_locations",
                },
                exclude_none=True,
            )
            notes.append(
                f"Weld {i}: "
                + ", ".join(
                    k.replace("_", " ") + " " + str(v) for k, v in values.items()
                )
            )
        data = geom.part.model_dump()
        data.update(bends=bends, notes="\n".join(notes))
        parts.append(Part.model_validate(data))
    if not parts:
        raise ValueError("Add the part and its written dimensions.")
    return Drawing(title=title[:120], revision=str(version), units="in", parts=parts)


def blueprint_proof(ast, settings, title, version):
    try:
        drawing = blueprint_drawing(ast, settings, title, version)
        return proof(drawing, dict.fromkeys(f.reason for f in ast.review_flags()))
    except ValueError as exc:
        return blank([str(exc)])
