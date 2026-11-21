"""Live worker/API acceptance check. Run inside the isolated test Compose API container.

Uses the configured worker vision provider on synthetic PDF and DXF fixtures.
"""

import asyncio
import copy
import hashlib
import time
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from urllib.parse import urlencode
from uuid import uuid4

from fabrication.config import sessions
from fabrication.models import NickRule
from sqlalchemy.dialects.postgresql import insert

from packages.ai.examples.blueprint_demo import DXF_NOTES, make_drawing, make_metric_dxf
from packages.ai.schemas import EngineeringAST
from tests.integration import expect, request

CUSTOMER = "Blueprint acceptance fixture"
NUMBER = "P2-TRAINING-PLATE"
RULE = "P2-TRAINING-MARGIN"
BASE = "/v1/blueprints"


async def seed_rule():
    # This approval is scoped to the synthetic customer and remains idempotent across runs.
    async with sessions().begin() as db:
        await db.execute(
            insert(NickRule)
            .values(
                rule_key=RULE,
                revision=1,
                status="approved",
                approved_by="Acceptance fixture",
                rule_category="MARGIN",
                condition_json={"customer_name": CUSTOMER},
                adjustment={"kind": "set_margin_pct", "value": "28"},
                rationale="Training customer's approved pricing tier",
                citations=[],
                created_at=datetime(2020, 1, 1, tzinfo=UTC),
            )
            .on_conflict_do_nothing(index_elements=["rule_key", "revision"])
        )


def seed_history():
    payload = {
        "quote_number": NUMBER,
        "revision": 1,
        "customer_name": CUSTOMER,
        "job_name": "Fixture plate",
        "status": "approved",
        "gross_margin_pct": 28,
        "pricing_inputs": {},
        "lines": [
            {
                "line_key": "plate",
                "description": "Fixture plate",
                "quantity": 4,
                "entered": {
                    "retrieval": {
                        "material_family": "carbon steel",
                        "weight_lb": 1.698,
                        "processes": ["CUT"],
                    }
                },
                "ai_proposed": {"hours": 0.25},
                "nick_approved": {"hours": 0.35},
                "confidence_score": 0.9,
                "citations": [],
                "override_reason": "Allow time to square the sheet",
            }
        ],
    }
    assert request("/v1/quote-versions", "POST", payload)[0] in (200, 201)
    asyncio.run(seed_rule())


def submit(name, data, notes="", *, revision):
    params = urlencode(
        {
            "filename": name,
            "drawing_key": "blueprint-live-" + uuid4().hex,
            "revision": revision,
        }
    )
    drawing = expect(
        201,
        request(
            BASE + "/drawings?" + params,
            "POST",
            data,
            "application/pdf" if name.endswith(".pdf") else "application/dxf",
        ),
    )
    assert hashlib.sha256(data).hexdigest() == drawing["content_sha256"]
    assert expect(200, request(f"/v1/drawings/{drawing['id']}/source")) == data
    body = {
        "drawing_id": drawing["id"],
        "request_key": uuid4().hex,
        "notes": notes,
        "customer_name": CUSTOMER,
    }
    job = expect(202, request(BASE + "/jobs", "POST", body))
    assert (
        job["drawing"]["revision"] == revision and job["drawing"]["id"] == drawing["id"]
    )
    assert expect(202, request(BASE + "/jobs", "POST", body))["id"] == job["id"]
    expect(409, request(BASE + "/jobs", "POST", {**body, "notes": "different inputs"}))
    return BASE + "/jobs/" + job["id"]


def wait_for_job(url):
    deadline = time.monotonic() + 420
    while time.monotonic() < deadline:
        job = expect(200, request(url))
        if job["state"] == "failed":
            raise AssertionError(job["error"])
        if job["state"] in ("review_required", "ready"):
            return job
        time.sleep(1)
    raise AssertionError(
        "The live blueprint worker did not finish within seven minutes."
    )


def confirm_pdf(original):
    corrected = copy.deepcopy(original)
    corrected["issues"] = []
    corrected["source_units"] = "in"
    confirmed = {
        "FP-101": (4, 6, 4, "Fixture plate"),
        "FP-102": (2, 3, 2, "Shim plate"),
    }
    for part in corrected["parts"]:
        qty, width, height, description = confirmed[part["part_id"]]
        fields = {
            "quantity": qty,
            "material_family": "carbon steel",
            "material_grade": "A36",
            "description": description,
            "thickness_in": 0.25,
            "dimension_basis": "flat",
        }
        part.update(**fields, issues=[], requirements=[], finish=None)
        part["evidence"].append(
            {
                "source": "review",
                "fields": list(fields),
                "excerpt": "Synthetic customer confirmed material, quantity and blank dimensions.",
            }
        )
        outline = {
            "kind": "rectangle",
            "width_in": width,
            "height_in": height,
            "corner_radius_in": 0,
        }
        part["outline"].update(**outline, issues=[])
        part["outline"]["evidence"].append(
            {
                "source": "review",
                "fields": list(outline),
                "excerpt": "Dimensioned square-corner training plate.",
            }
        )
    return corrected


def verify():
    seed_history()
    run = submit("plate-set.pdf", make_drawing(missing=True), revision=2)
    native = submit("metric-plate.dxf", make_metric_dxf(), DXF_NOTES, revision=1)
    job = wait_for_job(run)
    assert job["state"] == "review_required" and job["result"] is None
    original = job["original_ast"]
    parts = {p["part_id"]: p for p in original["parts"]}
    assert set(parts) == {"FP-101", "FP-102"}
    assert parts["FP-101"]["quantity"] == 4 and parts["FP-102"]["quantity"] is None
    assert (
        parts["FP-102"]["material_grade"] is None
        and parts["FP-102"]["thickness_in"] is None
    )
    assert any(
        f["kind"] == "missing" and f["path"].endswith(".quantity") for f in job["flags"]
    )
    unchanged = {
        "ast": original,
        "version": job["version"],
        "confirmed": True,
        "reason": "No correction yet",
    }
    expect(422, request(run + "/review", "POST", unchanged))
    ast = confirm_pdf(original)
    flags = EngineeringAST.model_validate(ast).review_flags()
    assert all(f.kind == "low_confidence" for f in flags), flags
    edit = {
        **unchanged,
        "ast": ast,
        "reason": "Synthetic customer confirmed shim specifications.",
        "accepted_low_confidence": [f.path for f in flags],
    }
    incomplete = copy.deepcopy(edit)
    del incomplete["ast"]["parts"][0]["holes"]
    expect(422, request(run + "/review", "POST", incomplete))
    saved = expect(202, request(run + "/review", "POST", edit))
    expect(409, request(run + "/review", "POST", edit))
    ready = wait_for_job(run)
    assert ready["state"] == "ready", (ready["flags"], ready["error"])
    assert ready["version"] == saved["version"] and ready["original_ast"] == original
    assert ready["review_log"][-1]["reason"] == edit["reason"]
    result = ready["result"]
    assert Decimal(result["gross_margin_pct"]) == 28 and len(result["lines"]) == 2
    cost = Decimal(result["estimated_cost_usd"])
    assert cost > 0 and Decimal(result["selling_price_usd"]) == (
        cost / Decimal(".72")
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    assert any(
        h["quote_number"] == NUMBER
        and h["citation"]["reference"]
        and h["override_reason"]
        for line in result["lines"]
        for h in line["history"]
    )
    assert all(
        any(r["kind"] == "nick_rule" for r in line["rules"]) for line in result["lines"]
    )
    assert all(line["rows"] and line["baseline_rows"] for line in result["lines"])
    dxf = wait_for_job(native)
    preview = expect(200, request(BASE + "/drawings/" + dxf["drawing"]["id"] + "/preview"))
    assert preview[:3] == bytes.fromhex("ffd8ff")
    parsed = dxf["original_ast"]
    assert parsed["source_units"] == "mm" and len(parsed["parts"]) == 1
    p = parsed["parts"][0]
    assert p["quantity"] == 4 and abs(p["thickness_in"] - 0.25) < 1e-8
    assert (
        abs(p["outline"]["width_in"] - 6) < 1e-8
        and abs(p["outline"]["height_in"] - 4) < 1e-8
    )
    assert any(e["source"] == "dxf" and e["handle"] for e in p["outline"]["evidence"])
    print(
        f"Live {job['model']} | PDF and DXF revisions recovered | missing inputs held, corrected, "
        f"stale version rejected | cost {cost}, price {result['selling_price_usd']} at 28% | "
        f"archived quote and approved rule cited | PDF job {ready['id']} | DXF {dxf['state']}"
    )


if __name__ == "__main__":
    verify()
