"""Persisted work queue for immutable blueprint revisions. Celery only carries identifiers."""

import asyncio
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import or_, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import load_only
from sqlalchemy.pool import NullPool

from packages.ai.blueprint_extractor import extract_blueprint
from packages.ai.quote_rag import apply_rules, resolve_margin, retrieve_context
from packages.ai.schemas import EngineeringAST
from packages.ai.hosted_history import matches_hosted
from packages.cad.cost_engine import CostInputError, calculate_cost, reprice_result
from .config import database_url, sessions
from .models import BlueprintQuoteJob as Job, Drawing
from .storage import read_source
from .tasks import worker

logger = logging.getLogger(__name__)
ACTIVE = ("queued", "extracting", "costing")


async def dispatch_pending():
    now = datetime.now(timezone.utc)
    async with sessions().begin() as db:
        pending = await db.scalars(
            select(Job)
            .options(load_only(Job.id, Job.version, Job.claimed_at))
            .where(
                Job.state.in_(ACTIVE),
                or_(
                    Job.claimed_at.is_(None),
                    Job.claimed_at < now - timedelta(minutes=6),
                ),
            )
            .order_by(Job.created_at)
            .with_for_update(skip_locked=True)
            .limit(20)
        )
        for job in pending:
            await asyncio.to_thread(
                generate.apply_async, args=(str(job.id), job.version), retry=False
            )
            job.claimed_at = now


async def dispatcher():
    from .sketch_jobs import dispatch_sketches
    from packages.ai.rule_distiller import dispatch_preferences
    while True:
        try:
            await dispatch_pending()
        except Exception:
            logger.warning("Blueprint dispatch unavailable. Retrying stored jobs.")
        try:
            await dispatch_sketches()
        except Exception:
            logger.warning("Sketch dispatch unavailable. Retrying stored drawings.")
        try:
            await dispatch_preferences()
        except Exception:
            logger.warning("Preference dispatch unavailable. Finalized quotes remain queued.")
        await asyncio.sleep(2)


async def set_state(factory, job_id, version, **values):
    async with factory.begin() as db:
        updated = await db.execute(
            update(Job)
            .where(Job.id == job_id, Job.version == version, Job.state.in_(ACTIVE))
            .values(**values)
        )
        return updated.rowcount == 1


async def estimate(db, job, ast):
    accepted = (
        job.review_log[-1].get("accepted_low_confidence", []) if job.review_log else []
    )
    base = await asyncio.to_thread(
        calculate_cost,
        ast,
        job.inputs["settings"],
        accepted_low_confidence=frozenset(accepted),
    )
    contexts = []
    parts = {part.part_id: part for part in ast.parts}
    archived_as_of = job.review_log[-1].get("reviewed_at") if job.review_log else None
    as_of = datetime.fromisoformat(archived_as_of) if archived_as_of else job.created_at
    for line in base["lines"]:
        part = parts[line["part_id"]]
        context = await retrieve_context(
            db,
            description=line["description"],
            quantity=line["quantity"],
            material_family=line["material_family"],
            thickness_in=part.thickness_in,
            weight_lb=float(line["weight_lb"]),
            processes=line["processes"],
            as_of=as_of,
            customer_name=job.inputs["customer_name"],
            exclude_drawing_id=job.drawing_id,
            exclude_quote_number=job.inputs.get("quote_number"),
        )
        adjusted = apply_rules(
            cost_rows=line["rows"],
            margin_pct=base["gross_margin_pct"],
            rules=context["rules"],
        )
        line["baseline_rows"] = line["rows"]
        line["rows"] = adjusted["cost_rows"]
        hosted = matches_hosted(job.inputs.get("hosted_history", []), part=part, line=line,
                                as_of=as_of, exclude_quote_number=job.inputs.get("quote_number"))
        hosted_numbers = {match["quote_number"] for match in hosted}
        local = [match for match in context["historical_quotes"] if match["quote_number"] not in hosted_numbers]
        line["history"] = [*hosted[:3], *local, *hosted[3:]][:5]
        line["rules"] = adjusted["applied_rules"]
        line["warnings"] = adjusted["warnings"] + context.get("warnings", [])
        line["retrieval_filters"] = context["filters"]
        line["embedding_model"] = context["embedding_model"]
        contexts.append(context)
    margin, warnings = resolve_margin(base["gross_margin_pct"], contexts)
    margin_sources = {
        r["citation"]["reference"]: r["citation"]
        for c in contexts
        for r in c["rules"]
        if r["adjustment"]["kind"] == "set_margin_pct"
    }
    if warnings:
        for line in base["lines"]:
            line["rules"] = [
                c for c in line["rules"] if c["reference"] not in margin_sources
            ]
    base["margin_rule_citations"] = [] if warnings else list(margin_sources.values())
    base["gross_margin_pct"] = margin
    base["warnings"] = warnings + (["Supabase history was unavailable when this estimate started. Local engineering history was used."]
                                   if job.inputs.get("hosted_history_status") == "unavailable" else [])
    return reprice_result(base)


async def run_job(job_id, version):
    # A dedicated session lock survives the short state transactions. Worker loss releases it.
    engine = create_async_engine(database_url(), poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.connect() as lock:
            acquired = await lock.scalar(
                text("SELECT pg_try_advisory_lock(hashtextextended(:key,0))"),
                {"key": "blueprint/" + str(job_id)},
            )
            if not acquired:
                return
            async with factory() as db:
                job = await db.get(Job, job_id)
                if not job or job.version != version or job.state not in ACTIVE:
                    return
                drawing = await db.get(Drawing, job.drawing_id)
            try:
                extraction = job.extraction
                if extraction is None:
                    await set_state(factory, job_id, version, state="extracting")
                    content = await asyncio.to_thread(
                        read_source, drawing.source_key, drawing.source_version
                    )
                    if hashlib.sha256(content).hexdigest() != drawing.content_sha256:
                        raise ValueError(
                            "The stored file does not match its original checksum."
                        )
                    reading = await asyncio.to_thread(
                        extract_blueprint,
                        content,
                        drawing.original_filename,
                        job.inputs["notes"],
                    )
                    extraction = reading.model_dump(mode="json")
                    needs_review = any(flag.blocks_pricing for flag in reading.flags)
                    if not await set_state(
                        factory,
                        job_id,
                        version,
                        extraction=extraction,
                        state="review_required" if needs_review else "costing",
                    ):
                        return
                    if needs_review:
                        return
                ast = EngineeringAST.model_validate(
                    job.reviewed_ast or extraction["ast"]
                )
                async with factory.begin() as db:
                    result = await estimate(db, job, ast)
                await set_state(
                    factory, job_id, version, state="ready", result=result, error=None
                )
            except CostInputError as exc:
                await set_state(
                    factory,
                    job_id,
                    version,
                    state="review_required",
                    error="\n".join(exc.issues)[:12000],
                )
            except (ValueError, RuntimeError) as exc:
                # Provider adapter uses sanitized, staff-facing diagnostics.
                await set_state(
                    factory, job_id, version, state="failed", error=str(exc)[:2000]
                )
            except Exception as exc:
                logger.error("Blueprint job %s failed (%s)", job_id, type(exc).__name__)
                await set_state(
                    factory,
                    job_id,
                    version,
                    state="failed",
                    error="Processing stopped. Retry this saved drawing.",
                )
    finally:
        await engine.dispose()


@worker.task(
    name="fabrication.generate_blueprint_quote",
    acks_late=True,
    reject_on_worker_lost=True,
    ignore_result=True,
    soft_time_limit=540,
    time_limit=600,
)
def generate(job_id, version):
    asyncio.run(run_job(UUID(job_id), version))
