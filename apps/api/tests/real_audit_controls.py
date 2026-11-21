"""Deterministic controls around the real database and production estimate worker."""

import asyncio
from datetime import UTC, datetime
from decimal import Decimal
from math import pi
from types import SimpleNamespace
from uuid import uuid4

from fabrication.blueprint_jobs import estimate
from fabrication.config import sessions
from sqlalchemy import text

from packages.ai.schemas import EngineeringAST
from packages.cad.cost_engine import CostInputError
from packages.cad.tests.test_cost_engine import ast, bend, evidence, plate, rates, weld
from tests.blueprint_flow import CUSTOMER, RULE, seed_rule
from tests.integration import request

NUMBER = "P4-QA-COST-" + uuid4().hex[:12]


def seed_history():
    status, result = request(
        "/v1/quote-versions",
        "POST",
        {
            "quote_number": NUMBER,
            "revision": 1,
            "customer_name": CUSTOMER,
            "job_name": "Comparable fixture plate",
            "status": "approved",
            "gross_margin_pct": 28,
            "pricing_inputs": {},
            "lines": [
                {
                    "line_key": "fixture",
                    "description": "Fixture plate",
                    "quantity": 4,
                    "entered": {
                        "retrieval": {
                            "material_family": "carbon steel",
                            "weight_lb": 1.7,
                            "processes": ["CUT", "BEND", "GMAW"],
                        }
                    },
                    "ai_proposed": {"cost": 100},
                    "nick_approved": {"cost": 100},
                    "confidence_score": 0.9,
                    "citations": [],
                }
            ],
        },
    )
    assert status in (200, 201), result


async def run():
    await asyncio.to_thread(seed_history)
    await seed_rule()
    now = datetime.now(UTC)
    card = rates()
    part = plate(qty=4)
    part["description"] = "Fixture plate"
    part["welds"] = [weld(increment_in=3, pitch_in=12, position="3F")]
    part["bends"] = [bend()]
    part["holes"] = [
        evidence(
            shape="round",
            cutting_method="cut",
            center_x_in=2.5,
            center_y_in=2.5,
            diameter_in=1,
        )
    ]
    card["cut"].update(kerf_in="0.1", seconds_per_pierce=2)
    card["welds"][0].update(
        filler_density_lb_per_in3=".3",
        deposit_lb_per_arc_hour=2,
        deposition_efficiency=".8",
        arc_on_fraction=".5",
        position_factors={"3F": ".5"},
        gas_flow_scfh=30,
        gas_seconds_per_start=5,
    )
    job = SimpleNamespace(
        created_at=now,
        inputs={"settings": card, "customer_name": CUSTOMER},
        drawing_id=None,
        review_log=[],
    )
    async with sessions()() as db:
        assert await db.scalar(text("SELECT count(*) FROM materials")) > 0
        assert await db.scalar(text("SELECT count(*) FROM work_centers")) > 0
        model = EngineeringAST.model_validate(ast(part))
        result = await estimate(db, job, model)
        line = result["lines"][0]
        metrics = line["metrics"]
        use = metrics["welds"][0]
        group = result["stock_groups"][0]
        assert metrics["pierces"] == 8 and group["sheet_count"] == 4
        assert abs(float(metrics["kerf_path_in"]) - 4 * (20 + pi)) < 1e-7
        assert abs(float(group["net_yield_pct"]) - (25 - pi / 4)) < 1e-7
        assert Decimal(group["net_yield_pct"]) + Decimal(group["scrap_pct"]) == 100
        assert use["starts"] == 16 and use["welded_length_in"] == "48"
        assert use["filler_lb"] == "0.5625" and use["arc_hours"] == "0.45"
        assert abs(float(use["gas_scf"]) - 30 * (0.45 + 16 * 5 / 3600)) < 1e-7
        for operation in result["hours_by_work_center"]:
            assert (
                Decimal(operation["setup_hours"]) > 0
                and Decimal(operation["run_hours"]) > 0
            )
        assert result["gross_margin_pct"] == "28"
        assert any(
            RULE in item["excerpt"] or RULE in item["reference"]
            for item in line["rules"]
        )
        assert any(
            item["quote_number"] == NUMBER and item["citation"]["excerpt"]
            for item in line["history"]
        )
        assert all(row["basis_text"] and row["citations"] for row in line["rows"])
        part["material_grade"] = "2205"
        try:
            await estimate(db, job, EngineeringAST.model_validate(ast(part)))
        except CostInputError as error:
            assert "Select dated stock" in str(error) and "2205" in str(error)
        else:
            raise AssertionError("Unmapped duplex alloy received a quoted price")
    print(
        "Worker cost, scope, setup/run, batch kerf, yield, filler, gas, rule and pgvector citations reconciled. 2205 was held for stock mapping."
    )


if __name__ == "__main__":
    asyncio.run(run())
