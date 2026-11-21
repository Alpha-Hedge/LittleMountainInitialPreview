"""Derive reviewable shop rules from finalized, comparable decisions. No model credentials are needed."""

import asyncio
import hashlib
import itertools
import json
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from statistics import median
from uuid import UUID

from fabrication.config import database_url, sessions
from fabrication.models import Customer, NickRule, Quote, QuoteLineItem, WorkCenter
from fabrication.tasks import worker
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from packages.ai.quote_rag import CATEGORIES, STAGES, _fingerprint, validate_rule

D = Decimal


def number(value):
    try:
        n = D(str(value))
        return n if n.is_finite() and 0 <= n <= D("1e18") else None
    except (ValueError, InvalidOperation):
        return None


def digest(data):
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:32]


def operations(line, quote, legacy_center=""):
    """Older archives retain the blueprint rows and their approved extended costs."""
    if "review_operations" in line.entered:
        yield from line.entered["review_operations"]
        return
    ai, final = line.ai_proposed or {}, line.nick_approved or {}
    proposals = (ai.get("blueprint") or {}).get("rows", [])
    saved = {r.get("id"): r for r in final.get("costRows", [])}
    totals = quote.pricing_inputs.get("totals", {}).get("items", [])
    costs = {
        r["id"]: r["cost"]
        for item in totals
        if item.get("id") == line.line_key
        for r in item.get("rows", [])
    }
    for row in proposals:
        entry = saved.get(row["id"])
        if not entry:
            continue
        units = line.quantity if row.get("basis") == "per_unit" else 1
        factor = line.quantity if entry.get("basis") == "per_unit" else 1
        hours = number(row.get("amount")) if row.get("work_center") else None
        final_hours = number(entry.get("amount")) if hours is not None else None
        if (entry.get("estimate") or {}).get("unit") == "batch charge":
            final_hours = hours
            factor = units
        yield {
            "rowId": row["id"],
            "category": row["category"],
            "stage": row["stage"],
            "center": row.get("work_center") or "",
            "proposedBasis": row.get("basis"),
            "proposedAmount": row.get("amount"),
            "proposedRate": row.get("rate"),
            "amount": entry.get("amount"),
            "basis": entry.get("basis"),
            "aiHours": hours * units if hours is not None else None,
            "nickHours": final_hours * factor if final_hours is not None else None,
            "aiCost": row.get("cost_usd"),
            "nickCost": costs.get(row["id"]),
            "reason": (entry.get("estimate") or {}).get("overrideReason", ""),
        }
    if not proposals and ({"ai_cost", "ai_hours", "cost", "hours"} & ai.keys()):
        meta = line.entered
        center = meta.get("work_center") or legacy_center
        description = (center + " " + line.description).casefold()
        category = meta.get("category") or next(
            (
                key
                for key, terms in (
                    ("weld", ("weld", "mig", "tig")),
                    ("cut", ("saw", "plasma", "laser", "cut")),
                    ("bend", ("brake", "bend")),
                )
                if any(term in description for term in terms)
            ),
            "other",
        )
        yield {
            "rowId": line.line_key,
            "category": category,
            "stage": meta.get("stage")
            or ("setup" if "setup" in description else "run"),
            "center": center,
            "aiHours": ai.get("ai_hours", ai.get("hours")),
            "nickHours": final.get("nick_hours", final.get("hours")),
            "aiCost": ai.get("ai_cost", ai.get("cost")),
            "nickCost": final.get("nick_cost", final.get("cost")),
            "reason": line.override_reason,
        }


def observations(quote, line, tier, legacy_center=""):
    decision = (quote.pricing_inputs.get("details") or {}).get("pricingDecision") or {}
    if decision.get("kind") in {"one_time", "scope_change"} or not line.ai_proposed:
        return
    family, _, processes = _fingerprint(line)
    context = {"material_family": family} if family else {}
    info = line.entered.get("retrieval") or {}
    ast = (quote.pricing_inputs.get("blueprint") or {}).get("ast") or {}
    part = next(
        (p for p in ast.get("parts", []) if p.get("part_id") == line.line_key), {}
    )
    thickness = number(info.get("thickness_in", part.get("thickness_in")))
    if thickness:
        context["thickness_in"] = format(thickness.normalize(), "f")
    if tier and tier.upper() != "STANDARD":
        context["customer_tier"] = tier.strip().upper()
    for op in operations(line, quote, legacy_center):
        category, stage, center = (
            op.get("category"),
            op.get("stage"),
            str(op.get("center") or "").strip(),
        )
        if (
            category not in CATEGORIES
            or stage not in STAGES
            or op.get("disposition") == "one_time"
            or len(center) > 160
        ):
            continue
        if (
            str(op.get("reason") or line.override_reason or "")
            .lower()
            .startswith("quote-only exception:")
        ):
            continue
        condition = dict(context)
        if category == "weld":
            weld_processes = sorted(
                {
                    p.upper()
                    for p in processes
                    if p.upper() in {"GMAW", "GTAW", "FCAW", "SMAW", "MIG", "TIG"}
                }
            )
            if weld_processes:
                condition["processes"] = weld_processes
        if not condition:
            condition["customer_name"] = quote.customer_name
        ah, nh, ac, nc = (
            number(op.get(k)) for k in ("aiHours", "nickHours", "aiCost", "nickCost")
        )
        ratios = {}
        basis = op.get("proposedBasis") or "batch"
        units = line.quantity if basis == "per_unit" else 1
        if ah == 0 and nh is not None:
            ratios["fill_amount:" + basis] = nh / units
        elif (
            ah is None
            and number(op.get("proposedAmount")) == 0
            and op.get("basis") == basis
        ):
            amount = number(op.get("amount"))
            if amount is not None:
                ratios["fill_amount:" + basis] = amount
        # A zero quoted rate can be recovered from a known physical amount and a finalized cost.
        # Dividing by the approved amount prevents counting a simultaneous hours increase twice.
        if ac == 0 and nc is not None and number(op.get("proposedRate")) == 0:
            amount = nh if nh is not None else number(op.get("amount"))
            if amount and nh is None and op.get("basis") == "per_unit":
                amount *= line.quantity
            if amount:
                ratios["fill_rate:" + basis] = nc / amount
        if ah and nh is not None:
            ratios["hours"] = nh / ah
        if ac and nc is not None:
            if ah and nh:
                # Cost changes already explained by an hours change must not yield a second multiplier.
                ratios["cost"] = (nc / ac) / (nh / ah)
            elif ah is None or nh is None:
                ratios["cost"] = nc / ac
        for measure, factor in ratios.items():
            yield {
                "quote_id": quote.id,
                "line_id": line.id,
                "operation": str(op["rowId"]),
                "condition_json": json.dumps(condition),
                "category": category,
                "stage": stage,
                "center": center,
                "measure": measure,
                "pattern": digest([category, stage, center.casefold(), measure]),
                "ai_hours": ah,
                "nick_hours": nh,
                "ai_cost": ac,
                "nick_cost": nc,
                "factor": factor,
                "reason": (
                    op.get("reason")
                    or line.override_reason
                    or decision.get("reason")
                    or ""
                )[:1800],
            }


def candidate_groups(rows):
    groups = defaultdict(lambda: defaultdict(list))
    for row in rows:
        conditions = row["condition_json"]
        for n in range(1, len(conditions) + 1):
            for keys in itertools.combinations(sorted(conditions), n):
                key = json.dumps({k: conditions[k] for k in keys}, sort_keys=True)
                groups[key][row["quote_number"]].append(row)
    candidates = []
    for key, jobs in groups.items():
        if len(jobs) < 3:
            continue
        ratios = {
            job: median([r["factor"] for r in rows]) for job, rows in jobs.items()
        }
        middle = median(ratios.values())
        absolute = rows[0]["measure"].startswith("fill_")
        baseline = 0 if absolute else 1
        if abs(middle - baseline) < (
            D(".0001") if absolute else D(".01")
        ) or not 0 <= middle <= (D("1e9") if absolute else 10):
            continue
        matches = {
            j
            for j, r in ratios.items()
            if (r - baseline) * (middle - baseline) > 0
            and abs(r - middle) <= max(D(".015"), abs(middle - baseline) * D(".25"))
        }
        if len(matches) < 3 or len(matches) * 4 < len(jobs) * 3:
            continue
        factor = median([ratios[j] for j in matches]).quantize(
            D(".0001"), rounding=ROUND_HALF_UP
        )
        condition = json.loads(key)
        sample = [
            min(jobs[j], key=lambda r: abs(r["factor"] - ratios[j]))
            for j in sorted(matches)
        ]
        candidates.append((condition, factor, sample, matches))
    # Different scopes with identical supporting jobs describe a single pattern.
    emitted = set()
    for condition, factor, sample, matches in sorted(
        candidates,
        key=lambda g: (-len(g[3]), -len(g[0]), json.dumps(g[0], sort_keys=True)),
    ):
        if matches & emitted:
            continue
        emitted.update(matches)
        yield condition, factor, sample


def change_text(row, before, after):
    a, b = row[before], row[after]
    return (
        f"{a:g} → {b:g} (Δ {b - a:+g})"
        if a is not None and b is not None
        else "unrecorded"
    )


async def refresh_pattern(db, pattern):
    stmt = text("""SELECT s.*,q.quote_number,q.revision,q.job_name FROM preference_samples s JOIN quotes q ON q.id=s.quote_id
      WHERE s.pattern=:pattern AND NOT EXISTS (SELECT FROM quotes newer WHERE newer.quote_number=q.quote_number
      AND newer.revision>q.revision) ORDER BY q.quote_number,q.revision,s.line_id,s.operation""")
    samples = (await db.execute(stmt, {"pattern": pattern})).mappings().all()
    prefix = "PREF-" + pattern + "-"
    live = set()
    heads = {
        h.rule_key: h
        for h in await db.scalars(
            select(NickRule)
            .distinct(NickRule.rule_key)
            .where(NickRule.rule_key.startswith(prefix))
            .order_by(NickRule.rule_key, NickRule.revision.desc())
        )
    }
    for condition, factor, proof in candidate_groups(samples):
        name = prefix + digest(condition)
        live.add(name)
        prior = heads.get(name)
        if (
            prior
            and prior.status != "proposed"
            and not (prior.status == "retired" and prior.approved_by is None)
        ):
            continue
        first = proof[0]
        adjust = {
            "kind": "multiply_amount"
            if first["measure"] == "hours"
            else "multiply_rate",
            "category": first["category"],
            "stage": first["stage"],
            "factor": str(factor),
        }
        if first["measure"].startswith("fill_"):
            field, basis = first["measure"].split(":")
            adjust = {
                "kind": field,
                "category": first["category"],
                "stage": first["stage"],
                "basis": basis,
                "value": str(factor),
            }
        if first["center"]:
            adjust["work_center"] = first["center"]
        validate_rule(condition, adjust)
        rationale = f"{len(proof)} finalized jobs support {factor:g} × the proposed {first['measure']} for {first['center'] or first['category']} {first['stage']}."
        if adjust["kind"].startswith("fill_"):
            field = "rate" if adjust["kind"] == "fill_rate" else "amount"
            rationale = f"{len(proof)} finalized jobs set a zero {field} to {factor:g} on {adjust['basis']} {first['category']} {first['stage']} rows."
        citations = []
        for r in proof[-100:]:
            hours = change_text(r, "ai_hours", "nick_hours")
            cost = change_text(r, "ai_cost", "nick_cost")
            citations.append(
                {
                    "kind": "historical_job",
                    "reference": str(r["quote_id"]),
                    "excerpt": f"{r['quote_number']} v{r['revision']} · {r['job_name']} · hours {hours} · USD {cost} · {r['reason']}".rstrip(
                        " ·"
                    ),
                }
            )
        if prior and prior.citations == citations and prior.adjustment == adjust:
            continue
        db.add(
            NickRule(
                rule_key=name,
                revision=prior.revision + 1 if prior else 1,
                rule_category=first["category"],
                condition_json=condition,
                adjustment=adjust,
                rationale=rationale,
                citations=citations,
                status="proposed",
            )
        )
    for key, prior in heads.items():
        if prior.status == "proposed" and key not in live:
            db.add(
                NickRule(
                    rule_key=key,
                    revision=prior.revision + 1,
                    rule_category=prior.rule_category,
                    condition_json=prior.condition_json,
                    adjustment=prior.adjustment,
                    rationale="Newer finalized revisions superseded this evidence.",
                    citations=prior.citations,
                    status="retired",
                    approved_by=None,
                )
            )


async def process(db, quote_id):
    # Serialize evidence publication with rule decisions, including a retry after worker loss.
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext('shop-preference-distillation'))")
    )
    pending = await db.scalar(
        text(
            "SELECT completed_at IS NULL FROM preference_jobs WHERE quote_id=:id FOR UPDATE"
        ),
        {"id": quote_id},
    )
    if not pending:
        return
    quote = await db.get(Quote, quote_id)
    customer = await db.get(Customer, quote.customer_id)
    prior_patterns = set(
        await db.scalars(
            text("""SELECT DISTINCT s.pattern FROM preference_samples s JOIN quotes q ON q.id=s.quote_id
                                                 WHERE q.quote_number=:number"""),
            {"number": quote.quote_number},
        )
    )
    lines = await db.scalars(
        select(QuoteLineItem).where(QuoteLineItem.quote_id == quote.id)
    )
    for line in lines:
        center = (
            await db.get(WorkCenter, line.work_center_id)
            if line.work_center_id
            else None
        )
        for sample in observations(
            quote,
            line,
            quote.pricing_inputs.get("customer_tier") or customer.pricing_tier,
            center.name if center else "",
        ):
            prior_patterns.add(sample["pattern"])
            await db.execute(
                text("""INSERT INTO preference_samples VALUES (:quote_id,:line_id,:operation,:pattern,
                CAST(:condition_json AS jsonb),:category,:stage,:center,:measure,:ai_hours,:nick_hours,:ai_cost,:nick_cost,:factor,:reason)
                ON CONFLICT DO NOTHING"""),
                sample,
            )
    for pattern in sorted(prior_patterns):
        await refresh_pattern(db, pattern)
    await db.execute(
        text("UPDATE preference_jobs SET completed_at=now() WHERE quote_id=:id"),
        {"id": quote_id},
    )


async def run(quote_id):
    engine = create_async_engine(database_url(), poolclass=NullPool)
    try:
        async with async_sessionmaker(engine).begin() as db:
            await process(db, quote_id)
    finally:
        await engine.dispose()


@worker.task(
    name="fabrication.distill_quote",
    acks_late=True,
    reject_on_worker_lost=True,
    ignore_result=True,
)
def distill_quote(quote_id):
    asyncio.run(run(UUID(quote_id)))


async def dispatch_preferences():
    async with sessions().begin() as db:
        ids = await db.scalars(
            text("""SELECT quote_id FROM preference_jobs WHERE completed_at IS NULL AND
            (claimed_at IS NULL OR claimed_at < now()-interval '2 minutes') ORDER BY claimed_at NULLS FIRST
            LIMIT 12 FOR UPDATE SKIP LOCKED""")
        )
        for key in ids:
            await asyncio.to_thread(
                distill_quote.apply_async, args=(str(key),), retry=False
            )
            await db.execute(
                text("UPDATE preference_jobs SET claimed_at=now() WHERE quote_id=:id"),
                {"id": key},
            )
