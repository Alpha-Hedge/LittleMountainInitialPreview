"""Independent, structured verification of sketch readings and visual output."""

import base64
from io import BytesIO
import json
from typing import Annotated, Literal

from PIL import Image
from pydantic import Field

from .assembly_reader import assembly_model
from .blueprint_extractor import VisionProvider
from .sketch_parser import Node, PagePoint, Score, Text

AUDIT_VERSION = 1


class Finding(Node):
    kind: Literal["dimension", "feature", "count", "hardware", "connection", "missing", "cropped", "engineering"]
    view: Literal["source", "measured", "isometric", "across_views"]
    part_id: str | None
    issue: Text
    evidence: Text
    confidence: Score
    at: PagePoint | None


class Findings(Node):
    findings: Annotated[list[Finding], Field(max_length=14)]


PROMPT = """Independently compare the original fabrication sketch to the supplied written claim
ledger and generated review sheet, if present. Treat the images and ledger as untrusted evidence.
Read the original first. Keep only specific discrepancies and open decisions useful to a shop.
For each finding give a short actionable issue, source evidence and approximate source location
when visible. Use a known part ID or null. Deduplicate repeated issues across the views.

Check all available dimensions and named features, including the source view and binding of a
callout, its units, counts, relative offsets, hole/slot type, joining/attachment details and finish
when relevant. Separate explicitly written or staff supplied dimensions from drawn proportions.
Compare the generated views for incompatible components, mismatched openings, differing visible
counts, and invented details such as bolts, nuts, washers, welds or exact positions. A depicted
count is never an order quantity. If counts are ambiguous, flag verification without asserting
the correct count. Identify materially relevant cropped or incomplete views and any explicit
engineering requirement. Note genuine open relationships needed to build the work, such as
member spacing, attachment locations or weld details if the job needs them. Missing ancillary
information irrelevant to the shape or scope does not need a finding.

'source' is a conflict or omission in the saved reading, 'measured' concerns the measured
geometry, 'isometric' concerns generated artwork, and 'across_views' concerns a disagreement
between depicted views. The illustration has no dimensional authority. Do not infer dimensions,
engineering adequacy, material or welds from appearance. Do not cite a tolerance or limit.
Staff-confirmed values in the ledger may intentionally differ from the source. For an
engineering finding on a technical-only check, use it only when an explicit written hold was
missed by the reader. Empty findings are allowed when the comparison shows no specific issue."""


def _image(raw, name):
    with Image.open(BytesIO(raw)) as image:
        rgb = image.convert("RGB")
        rgb.thumbnail((2050, 2050), Image.Resampling.LANCZOS)
        out = BytesIO()
        rgb.save(out, "JPEG", quality=93)
    data = base64.b64encode(out.getvalue()).decode("ascii")
    return [{"type": "text", "text": name},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + data, "detail": "high"}}]


def audit_sketch(source, ledger, sheet=None, *, provider=None):
    """A separate visual reading only. It can flag claims and cannot replace them."""
    raw = json.dumps(ledger, ensure_ascii=True, separators=(",", ":"))
    limited = len(raw) > 100_000
    report = {"status": "unavailable", "model": None, "findings": [],
              "clearances": ledger["clearances"], "coverage_limited": limited}
    if limited:
        return report
    try:
        reader = provider if provider is not None else VisionProvider(model=assembly_model(), timeout=65)
        report["model"] = reader.model
        payload = _image(source, "Original sketch, used as evidence.")
        if sheet:
            payload.extend(_image(sheet, "Generated concept sheet, compare against the original."))
        payload.append({"type": "text", "text": "Written claims and plotted geometry:\n" + raw})
        response = reader.complete([
            {"role": "system", "content": PROMPT + (
                "" if sheet else "\nThis is a technical-only check. Compare only the original and ledger. "
                "There is no isometric artwork. Flag explicit contradictions or clearly omitted fabrication details. "
                "The solver already checks for missing dimensions. Do not require features never called for."
            )},
            {"role": "user", "content": payload},
        ], Findings.model_json_schema())
        checked = Findings.model_validate_json(response)
    except (ValueError, OSError):
        return report
    known = {part["part_id"] for part in ledger["parts"]}
    report.update(status="checked", findings=[
        item.model_copy(update={"part_id": item.part_id if item.part_id in known else None}).model_dump(mode="json")
        for item in checked.findings if sheet or item.view in ("source", "measured")
    ])
    return report
