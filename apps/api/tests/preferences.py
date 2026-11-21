"""Acceptance against isolated PostgreSQL, API, dispatcher and Celery. No vision call."""

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from fabrication.config import sessions
from sqlalchemy import text

from packages.ai.quote_rag import apply_rules, retrieve_context
from tests.integration import expect, request

BASE = "/v1/catalog/nick-rules"
RUN = "P4-" + uuid4().hex[:12]
CENTER = RUN + " weld"
THICKNESS = round(0.20 + int(RUN[3:9], 16) / 1e8, 8)


def finalize(job, revision=1, exception=False, same_hours=False):
    sample = {
        "rowId": "labor",
        "category": "weld",
        "stage": "setup",
        "center": CENTER,
        "aiHours": 0.75,
        "nickHours": 0.75 if same_hours else 1.5,
        "aiCost": 45,
        "nickCost": 45 if same_hours else 90,
        "reason": "Allow a second fixture alignment",
        "disposition": "one_time" if exception else "standard",
    }
    extra = {
        "rowId": "stock",
        "category": "material",
        "stage": "stock",
        "center": "",
        "aiHours": None,
        "nickHours": None,
        "aiCost": 100,
        "nickCost": 120,
        "reason": "Local supplier handling",
        "disposition": "one_time" if exception else "standard",
    }
    line = {
        "line_key": "plate",
        "description": "Fixture weldment",
        "quantity": 10,
        "entered": {
            "review_operations": [sample, extra],
            "retrieval": {
                "material_family": RUN,
                "thickness_in": THICKNESS,
                "processes": ["GMAW"],
            },
        },
        "ai_proposed": {"operations": [{"id": "labor"}, {"id": "stock"}]},
        "nick_approved": {"cost": 210},
        "confidence_score": 0.88,
        "citations": [],
    }
    body = {
        "quote_number": RUN + "-" + str(job),
        "revision": revision,
        "customer_name": RUN,
        "job_name": "Fixture " + str(job),
        "gross_margin_pct": 25,
        "status": "approved",
        "pricing_inputs": {},
        "lines": [line],
    }
    status, data = request("/v1/quote-versions", "POST", body)
    assert status in (200, 201), data
    return data["id"]


async def count(ids):
    async with sessions()() as db:
        return await db.scalar(
            text(
                "SELECT count(*) FROM preference_jobs WHERE completed_at IS NOT NULL AND CAST(quote_id AS text)=ANY(:ids)"
            ),
            {"ids": ids},
        )


def settle(ids):
    async def wait():
        for _ in range(120):
            if await count(ids) == len(ids):
                return
            await asyncio.sleep(0.25)
        raise AssertionError("Preference jobs did not complete")

    asyncio.run(wait())


def suggested():
    return [
        r
        for r in expect(200, request(BASE + "/suggestions"))
        if any(RUN in c["excerpt"] or RUN in c["reference"] for c in r["citations"])
    ]


async def future():
    async with sessions()() as db:
        context = await retrieve_context(
            db,
            description="Fixture weldment",
            quantity=10,
            material_family=RUN,
            processes=["GMAW"],
            thickness_in=THICKNESS,
            weight_lb=None,
            customer_name=RUN,
            as_of=datetime.now(UTC),
        )
        return apply_rules(
            cost_rows=[
                {
                    "work_center": CENTER,
                    "category": "weld",
                    "stage": "setup",
                    "amount": ".75",
                    "rate": "60",
                }
            ],
            margin_pct=25,
            rules=context["rules"],
        )


def zero_baseline():
    from types import SimpleNamespace

    from packages.ai.rule_distiller import candidate_groups, observations

    quote = SimpleNamespace(id=RUN, customer_name=RUN, pricing_inputs={})
    op = {
        "rowId": "tack",
        "category": "weld",
        "stage": "setup",
        "center": CENTER,
        "aiHours": 0,
        "nickHours": 2,
        "aiCost": 0,
        "nickCost": 120,
        "proposedRate": 60,
        "proposedBasis": "per_unit",
    }
    line = SimpleNamespace(
        id=RUN,
        line_key="plate",
        description="plate",
        quantity=4,
        ai_proposed={"hours": 0},
        entered={"review_operations": [op]},
        nick_approved={"hours": 2},
        override_reason="",
    )
    samples = list(observations(quote, line, "STANDARD"))
    assert len(samples) == 1 and samples[0]["factor"] == 0.5
    rows = [
        {
            **samples[0],
            "condition_json": {"material_family": "steel"},
            "quote_number": str(i),
        }
        for i in range(3)
    ]
    assert next(candidate_groups(rows))[1] == 0.5
    adjustment = {
        "kind": "fill_amount",
        "basis": "per_unit",
        "category": "weld",
        "stage": "setup",
        "value": ".5",
    }
    rule = {
        "id": "test",
        "rule_key": "test",
        "condition": {},
        "adjustment": adjustment,
        "citation": {"reference": "fixture"},
    }

    def apply(amount, basis):
        row = {
            "work_center": CENTER,
            "category": "weld",
            "stage": "setup",
            "amount": amount,
            "rate": "60",
            "basis": basis,
        }
        return apply_rules(cost_rows=[row], rules=[rule], margin_pct=25)["cost_rows"][
            0
        ]["amount"]

    assert (
        apply("0", "per_unit") == "0.5"
        and apply("1", "per_unit") == "1"
        and apply("0", "batch") == "0"
    )


def run():
    zero_baseline()
    ids = [finalize(1), finalize(1, 2), finalize(2), finalize(4, exception=True)]
    assert finalize(2) == ids[2]
    settle(ids)
    assert not suggested()
    settle([finalize(3)])
    rules = suggested()
    assert len(rules) == 2, [(r["condition_json"], r["adjustment"]) for r in rules]
    change = next(r for r in rules if r["adjustment"]["kind"] == "multiply_amount")
    cost = next(r for r in rules if r["adjustment"]["kind"] == "multiply_rate")
    assert (
        float(change["adjustment"]["factor"]) == 2
        and float(cost["adjustment"]["factor"]) == 1.2
    )
    assert len(change["citations"]) == 3 and change["condition_json"]["processes"] == [
        "GMAW"
    ]
    assert not asyncio.run(future())["applied_rules"]
    for rec, action in [(change, "approve"), (cost, "dismiss")]:
        route = BASE + "/" + rec["rule_key"] + "/decision"
        payload = {
            "expected_revision": rec["revision"],
            "action": action,
            "reviewer": "Nick",
        }
        saved = expect(200, request(route, "POST", payload))
        assert expect(200, request(route, "POST", payload))["id"] == saved["id"]
        expect(
            409,
            request(
                route,
                "POST",
                {**payload, "action": "dismiss" if action == "approve" else "approve"},
            ),
        )
    next_quote = asyncio.run(future())
    assert (
        float(next_quote["cost_rows"][0]["amount"]) == 1.5
        and next_quote["cost_rows"][0]["rate"] == "60"
    )
    assert next_quote["applied_rules"][0]["kind"] == "nick_rule"
    settle([finalize(5)])
    assert not suggested()
    print(
        "Three distinct finalized jobs produced two cited suggestions. Duplicate delivery, revisions, and one-time edits were excluded. Approval doubled future setup only; dismissal stayed dismissed."
    )


if __name__ == "__main__":
    from fabrication.config import database_url
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    # Separate event loops in this executable must not reuse pooled database connections.
    factory = async_sessionmaker(
        create_async_engine(database_url(), poolclass=NullPool), expire_on_commit=False
    )
    sessions = lambda: factory
    run()
