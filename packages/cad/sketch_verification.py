"""Measurements and geometry evidence for comparing a sketch and its drawings."""

import re

from shapely.geometry import LineString

from .geometry import sampled, solve_part
from .schema import RoundHole


def disputed_rod_layout(audit):
    return any(
        finding["confidence"] >= .85
        and (finding["kind"] == "count" or (finding["kind"] == "feature" and finding["view"] == "across_views"))
        and re.search(r"\b(?:rods?|studs?)\b", finding["issue"], re.I)
        for finding in audit["findings"]
    )


def edge_clearance(geometry, labels):
    """Smallest drawn clearance, never a structural acceptance check."""
    if not geometry.inner:
        return None
    points = sampled(geometry.outer)
    boundary = LineString([*points, points[0]])
    distance, label = min(
        (boundary.distance(opening.axis) - opening.radius, label)
        for opening, label in zip(geometry.inner, labels, strict=True)
    )
    return {"opening": label, "gap": round(distance, 8),
            "approximate": any(vertex[2] for vertex in geometry.outer)}


def sketch_evidence(reading, solved, *, bar_plan=None):
    """Build a ledger of written claims and exact plotted features from the solver."""
    parts = []
    clearances = []
    full_parts = {part.part_id: part for part in solved.drawing.parts} if solved.drawing else {}
    for index, part in enumerate(reading.parts):
        draft = solved.draft_plans[index] if solved.draft_plans else None
        approved = full_parts.get(part.part_id)
        geom = draft.geometry if draft else solve_part(approved) if approved else None
        claims = [
            [mark.kind, mark.targets, mark.value, mark.evidence,
             "staff" if mark.evidence.startswith("Staff confirmed ") else "read from sketch"]
            for mark in part.annotations
        ]
        entry = {"part_id": part.part_id, "label": part.name, "shape": part.shape,
                 "claims": claims, "questions": [q.text for q in part.questions]}
        if geom:
            profile = geom.part
            labels = draft.hole_labels if draft else [f"H{i}" for i in range(1, len(profile.holes) + 1)]
            entry["plotted"] = {
                "outline": profile.outline.model_dump(mode="json"),
                "openings": [
                    {"id": label, "kind": "round" if isinstance(hole, RoundHole) else "slot",
                     **hole.model_dump(mode="json")}
                    for label, hole in zip(labels, profile.holes, strict=True)
                ],
                "bends": [bend.model_dump(mode="json") for bend in profile.bends],
                "range": geom.bounds,
            }
            if approved:
                entry["plotted"].update(material=approved.material, quantity=approved.quantity,
                                        thickness=approved.thickness)
            if draft and (draft.corner_open or draft.omitted):
                entry["geometry_open"] = {"corners": draft.corner_open, "omitted": draft.omitted}
            if gap := edge_clearance(geom, labels):
                clearances.append({"part": part.name, "units": reading.units, **gap})
        parts.append(entry)
    views = {
        "measured_details": "Written dimensions converted by the geometry solver.",
        "isometric": "AI visual interpretation only. Never a source of a dimension or manufacturing detail.",
    }
    if bar_plan:
        views["bar_views"] = {
            "width": bar_plan.face_width, "thickness": bar_plan.stock_thickness,
            "length_callout": bar_plan.written_length,
            "rod_marks_by_bar": [len(row) for row in bar_plan.rods],
            "rod_positions": "Approximate from the sketch. No confirmed count, pitch or offsets.",
        }
    return {"units": reading.units, "unit_evidence": reading.unit_evidence,
            "parts": parts, "views": views, "clearances": clearances}
