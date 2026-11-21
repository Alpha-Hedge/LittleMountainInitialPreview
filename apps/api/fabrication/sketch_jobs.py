"""Durable photo interpretation and atomic publication of an audited set of shop files."""

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from minio.error import S3Error
from redis import Redis, RedisError
from sqlalchemy import or_, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import load_only
from sqlalchemy.pool import NullPool

from packages.ai.assembly_reader import AssemblyReading, assemble_reference, assembly_model
from packages.ai.sketch_audit import AUDIT_VERSION, audit_sketch
from packages.ai.sketch_parser import SketchMap, parse_sketch
from packages.ai.sketch_visual import locate_callouts, render_visual
from packages.cad.constraint_solver import WarningPin, review_key, sketch_note_pins, solve_sketch
from packages.cad.dxf_compiler import compile_solved_sketch
from packages.cad.presentation_sheet import (
    LAYOUT_VERSION, assembly_top_view, bar_stock, make_presentation_sheet, presentation_png, primary_detail,
    saved_illustration, written_callouts,
)
from packages.cad.sketch_rectifier import rectify_sketch
from packages.cad.sketch_verification import disputed_rod_layout, sketch_evidence
from .config import database_url, redis_url, sessions
from .models import Drawing, SketchRevision as Revision, SketchVisualPreview
from .storage import read_source, store_sketch_file
from .tasks import worker

ACTIVE = ("queued", "reading")
logger = logging.getLogger(__name__)
ASSEMBLY_VERSION = 2


def assembly_key(source):
    return f"sketch:assembly:{ASSEMBLY_VERSION}:{assembly_model()}:{source['sha256']}"


def saved_assembly(source):
    with Redis.from_url(redis_url(1), socket_connect_timeout=3, socket_timeout=3) as cache:
        raw = cache.get(assembly_key(source))
    return json.loads(raw) if raw else None


def cache_assembly(source, result):
    with Redis.from_url(redis_url(1), socket_connect_timeout=3, socket_timeout=3) as cache:
        cache.set(assembly_key(source), json.dumps(result), ex=60 * 60 * 24 * 30)


async def assembly_for_drawing(drawing_id):
    engine = create_async_engine(database_url(), poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as db:
            first = await db.scalar(select(Revision).where(
                Revision.drawing_id == UUID(drawing_id), Revision.number == 1
            ))
        if first is None or not first.evidence or not first.evidence.get("page"):
            return None
        source = first.evidence["page"]
        async with engine.connect() as lock:
            locked = await lock.scalar(
                text("SELECT pg_try_advisory_lock(hashtextextended(:key,0))"),
                {"key": assembly_key(source)},
            )
            if not locked:
                return None
            if cached := await asyncio.to_thread(saved_assembly, source):
                return cached
            photo = await asyncio.to_thread(read_source, source["key"], source["version"])
            if hashlib.sha256(photo).hexdigest() != source["sha256"]:
                raise ValueError("The saved photo preview failed its checksum check.")
            reading, model = await asyncio.to_thread(assemble_reference, photo)
            result = {"schema_version": ASSEMBLY_VERSION, "model": model, "reading": reading.model_dump(mode="json")}
            await asyncio.to_thread(cache_assembly, source, result)
            return result
    finally:
        await engine.dispose()


@worker.task(name="fabrication.sketch_assembly_reference", soft_time_limit=185, time_limit=200)
def sketch_assembly_reference(drawing_id):
    return asyncio.run(assembly_for_drawing(drawing_id))


async def previous_visual(db, revision):
    source_hash = select(Drawing.content_sha256).where(Drawing.id == revision.drawing_id).correlate(None).scalar_subquery()
    layouts = SketchVisualPreview.file["layout_version"].as_integer()
    return (await db.execute(
        select(SketchVisualPreview.file, SketchVisualPreview.model)
        .join(Revision, SketchVisualPreview.revision_id == Revision.id)
        .join(Drawing, Drawing.id == Revision.drawing_id)
        .where(Drawing.content_sha256 == source_hash, Revision.id != revision.id,
               SketchVisualPreview.state == "ready", SketchVisualPreview.model.is_not(None),
               layouts.between(2, LAYOUT_VERSION))
        .order_by(SketchVisualPreview.started_at.desc(), Revision.number.desc())
        .limit(1)
    )).first()


async def render_saved_visual(revision_id, attempt_id, new_image=False):
    engine = create_async_engine(database_url(), poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory.begin() as db:
            job = await db.get(SketchVisualPreview, revision_id, with_for_update=True)
            if job is None or job.attempt_id != attempt_id or job.state != "queued":
                return
            rev = await db.get(Revision, revision_id)
            evidence = await db.scalar(select(Revision.evidence).where(
                Revision.drawing_id == rev.drawing_id, Revision.number == 1
            ))
            source = evidence["page"]
            checked = (rev.solution or {}).get("drawing") if rev.state == "released" else None
            previous_file, previous_model = job.file, job.model
            artwork = None
            if not new_image:
                if previous_file and previous_model and previous_file.get("layout_version") in range(2, LAYOUT_VERSION + 1):
                    artwork = previous_file, previous_model
                else:
                    artwork = await previous_visual(db, rev)
            job.state = "rendering"
            job.started_at = datetime.now(timezone.utc)

        def generate_image():
            photo = read_source(source["key"], source["version"])
            if hashlib.sha256(photo).hexdigest() != source["sha256"]:
                raise ValueError("The saved sketch failed its checksum check.")
            reading = SketchMap.model_validate(rev.reading)
            solution = solve_sketch(reading, evidence["registration"]["size"], revision=rev.number,
                                    candidates=evidence["candidates"], accepted=rev.accepted, draft=True)
            detail = primary_detail(reading, solution)
            callouts = written_callouts(reading, detail)
            context = {"title": reading.title, "units": reading.units,
                       "parts": [p.name for p in reading.parts], "written_callouts": [c.text for c in callouts]}
            assembly = None
            try:
                if plan := saved_assembly(source):
                    assembly = AssemblyReading.model_validate(plan["reading"])
                elif detail and bar_stock(reading):
                    assembly, plan_model = assemble_reference(photo, timeout=40)
                    cache_assembly(source, {"schema_version": ASSEMBLY_VERSION, "model": plan_model,
                                            "reading": assembly.model_dump(mode="json")})
            except (RedisError, ValueError, KeyError):
                pass
            if assembly:
                context["visible_members"] = [member.label for member in assembly.members]
                context["visible_hardware_marks"] = [
                    {"label": group.label, "visible_marks": len(group.marks)} for group in assembly.hardware
                ]
            art = None
            if artwork:
                file, saved_model = artwork
                try:
                    old = file["pdf"]
                    old_pdf = read_source(old["key"], old["version"])
                    if hashlib.sha256(old_pdf).hexdigest() == old["sha256"]:
                        art, model = saved_illustration(old_pdf), saved_model
                except (KeyError, OSError, RuntimeError, ValueError, S3Error) as exc:
                    logger.info("Saved illustration unavailable for revision %s (%s)", revision_id, type(exc).__name__)
            previous_audit = (previous_file.get("audit") if art and artwork[0] is previous_file
                              and previous_file.get("layout_version") == 5 else None)
            if art is None:
                art, model = render_visual(photo, checked, context)
            try:
                anchors = locate_callouts(art, {c.key: f"{c.heading} / {c.text}" for c in callouts})
            except ValueError as exc:
                logger.info("Callout leaders unavailable for revision %s (%s)", revision_id, type(exc).__name__)
                anchors = {}
            candidate = make_presentation_sheet(reading, rev.number, art, solution, detail, callouts, anchors,
                                                assembly=assembly)
            bar_plan = assembly_top_view(reading, detail, assembly)
            ledger = sketch_evidence(reading, solution, bar_plan=bar_plan)
            audit = dict(previous_audit) if previous_audit and previous_audit["status"] == "checked" else (
                audit_sketch(photo, ledger, presentation_png(candidate))
            )
            audit["rods_withheld"] = bool(bar_plan and any(bar_plan.rods) and disputed_rod_layout(audit))
            pdf = make_presentation_sheet(reading, rev.number, art, solution, detail, callouts, anchors,
                                          assembly=assembly, audit=audit)
            png = presentation_png(pdf)
            return {
                **store_sketch_file(png, f"drawing-rev-{rev.number}.png", "image/png"),
                "layout_version": LAYOUT_VERSION,
                "pdf": store_sketch_file(pdf, f"drawing-rev-{rev.number}.pdf", "application/pdf"),
                "audit": audit,
            }, model

        try:
            file, model = await asyncio.to_thread(generate_image)
            result = {"state": "ready", "file": file, "model": model, "error": None}
        except Exception as exc:
            logger.warning("Visual preview failed for revision %s (%s)", revision_id, type(exc).__name__)
            result = {"state": "failed", "error": str(exc) if isinstance(exc, ValueError) else
                      "Visual preview generation was interrupted. Try again."}
        async with factory.begin() as db:
            await db.execute(update(SketchVisualPreview).where(
                SketchVisualPreview.revision_id == revision_id, SketchVisualPreview.attempt_id == attempt_id
            ).values(**result))
    finally:
        await engine.dispose()


@worker.task(name="fabrication.sketch_visual_preview", ignore_result=True, soft_time_limit=390, time_limit=420)
def sketch_visual_preview(revision_id, attempt_id, new_image=False):
    asyncio.run(render_saved_visual(UUID(revision_id), UUID(attempt_id), new_image))


async def dispatch_sketches():
    now = datetime.now(timezone.utc)
    async with sessions().begin() as db:
        rows = await db.scalars(
            select(Revision)
            .options(load_only(Revision.id, Revision.claimed_at))
            .where(
                Revision.state.in_(ACTIVE),
                or_(Revision.claimed_at.is_(None), Revision.claimed_at < now - timedelta(minutes=6)),
            )
            .order_by(Revision.created_at)
            .limit(12)
            .with_for_update(skip_locked=True)
        )
        for r in rows:
            await asyncio.to_thread(generate.apply_async, args=(str(r.id),), retry=False)
            r.claimed_at = now


def interpret(drawing):
    original = read_source(drawing.source_key, drawing.source_version)
    if hashlib.sha256(original).hexdigest() != drawing.content_sha256:
        raise ValueError("The photo does not match its stored checksum.")
    page = rectify_sketch(original)
    reading = parse_sketch(page)
    evidence = {
        "registration": page.registration,
        "candidates": page.candidates,
        "model": reading.model,
        "provider": reading.provider,
        "raw": reading.raw,
        "page": store_sketch_file(page.jpeg(), "rectified.jpg", "image/jpeg"),
        "overlay": store_sketch_file(page.jpeg(True), "candidates.jpg", "image/jpeg"),
    }
    return reading.mapping.model_dump(mode="json"), evidence


def source_check_signature(reading, source):
    return review_key("source_check", str(AUDIT_VERSION) + source["sha256"] + reading.model_dump_json())


def release_check(reading, solved, source, accepted, previous_check):
    signature = source_check_signature(reading, source)
    if previous_check and previous_check.get("signature") == signature:
        audit = previous_check
    else:
        photo = read_source(source["key"], source["version"])
        if hashlib.sha256(photo).hexdigest() != source["sha256"]:
            raise ValueError("The saved sketch failed its checksum check.")
        audit = {"signature": signature, **audit_sketch(photo, sketch_evidence(reading, solved))}
    if audit["status"] == "unavailable":
        findings = [{"part_id": None, "at": None,
                     "issue": "The automatic comparison is unavailable. Check the original against the measured drawing.",
                     "evidence": ""}]
    else:
        findings = [item for item in audit["findings"]
                    if item["kind"] in ("dimension", "feature", "count", "engineering")
                    and item["confidence"] >= .90]
    pins = []
    for finding in findings:
        key = review_key("source_comparison", signature + json.dumps(finding, sort_keys=True))
        if key not in accepted:
            message = finding["issue"]
            if finding["evidence"]:
                message += " Source check. " + finding["evidence"]
            pins.append(WarningPin(code="source_comparison", part_id=finding["part_id"],
                                   target="drawing", at=finding["at"] or {"x": 500, "y": 500},
                                   message=message, review_key=key))
    return audit, pins


def evaluate(reading, evidence, rev, original_reading=None, previous_check=None):
    reading = SketchMap.model_validate(reading)
    solved = solve_sketch(
        reading,
        evidence["registration"]["size"],
        revision=rev.number,
        candidates=evidence["candidates"],
        accepted=rev.accepted,
    )
    # A reviewer can resolve an original hold but deleting its transcription must not clear it.
    if original_reading:
        keys = {pin.review_key for pin in solved.pins}
        solved.pins.extend(
            pin for pin in sketch_note_pins(SketchMap.model_validate(original_reading), rev.accepted)
            if pin.review_key not in keys
        )
    solution = {
        "pins": [p.model_dump() for p in solved.pins],
        "snapped_edges": solved.snapped_edges,
        "drawing": solved.drawing.model_dump(mode="json") if solved.drawing and not solved.pins else None,
    }
    if rev.review_first or solved.pins:
        if previous_check and previous_check.get("signature") == source_check_signature(reading, evidence["page"]):
            solution["source_check"] = previous_check
        return {"state": "needs_review", "solution": solution, "files": None}
    audit, pins = release_check(reading, solved, evidence["page"], rev.accepted, previous_check)
    solution["source_check"] = audit
    if pins:
        solution["pins"].extend(pin.model_dump() for pin in pins)
        return {"state": "needs_review", "solution": solution, "files": None}
    try:
        compiled = compile_solved_sketch(solved)
    except ValueError as exc:
        solution["pins"].append(
            {
                "code": "export",
                "part_id": None,
                "target": "drawing",
                "at": {"x": 500, "y": 500},
                "field": None,
                "annotation": None,
                "review_key": None,
                "message": str(exc),
            }
        )
        return {"state": "needs_review", "solution": solution, "files": None}
    files = [
        store_sketch_file(blob, f"part-{i:03}.dxf", "application/dxf")
        for i, blob in enumerate(compiled.dxfs, 1)
    ]
    files.append(store_sketch_file(compiled.pdf, "shop-drawing.pdf", "application/pdf"))
    files.append(store_sketch_file(compiled.csv, "bom.csv", "text/csv"))
    return {
        "state": "released",
        "solution": solution,
        "files": {"objects": files, "part_pages": compiled.part_pages},
    }


async def run(revision_id):
    engine = create_async_engine(database_url(), poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def save(**values):
        async with factory.begin() as db:
            await db.execute(
                update(Revision)
                .where(Revision.id == revision_id, Revision.state.in_(ACTIVE))
                .values(**values)
            )

    try:
        async with engine.connect() as lock:
            if not await lock.scalar(
                text("SELECT pg_try_advisory_lock(hashtextextended(:id,0))"),
                {"id": "sketch/" + str(revision_id)},
            ):
                return
            async with factory() as db:
                rev = await db.get(Revision, revision_id)
                if rev is None or rev.state not in ACTIVE:
                    return
                drawing = await db.get(Drawing, rev.drawing_id)
                first = await db.scalar(
                    select(Revision).where(Revision.drawing_id == drawing.id, Revision.number == 1)
                )
                previous = await db.scalar(select(Revision.solution).where(
                    Revision.drawing_id == drawing.id, Revision.number == rev.number - 1
                )) if rev.number > 1 else None
            try:
                await save(state="reading", error=None)
                mapping, evidence = rev.reading, first.evidence
                if mapping is None:
                    mapping, evidence = await asyncio.to_thread(interpret, drawing)
                    await save(reading=mapping, evidence=evidence)
                outcome = await asyncio.to_thread(evaluate, mapping, evidence, rev, first.reading,
                                                  (previous or {}).get("source_check"))
                await save(**outcome)
            except ValueError as exc:
                await save(state="failed", error=str(exc)[:1000])
            except Exception as exc:
                logger.error("Sketch revision %s interrupted (%s)", revision_id, type(exc).__name__)
                await save(state="failed", error="Processing was interrupted. Retry the saved photo.")
    finally:
        await engine.dispose()


@worker.task(
    name="fabrication.sketch_to_drawing",
    acks_late=True,
    reject_on_worker_lost=True,
    ignore_result=True,
    soft_time_limit=540,
    time_limit=600,
)
def generate(revision_id):
    asyncio.run(run(UUID(revision_id)))
