"""Authenticated photo-to-DXF conversion. Completed revision manifests are immutable."""

import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import quote
from uuid import UUID, uuid4

from celery.exceptions import CeleryError
from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from kombu.exceptions import OperationalError
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from redis import RedisError
from sqlalchemy import select, text, update
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from fabrication.config import sessions
from fabrication.drawing_records import LIMIT
from fabrication.models import Drawing, SketchRevision as Revision, SketchVisualPreview
from fabrication.sketch_jobs import saved_assembly, sketch_assembly_reference, sketch_visual_preview
from fabrication.storage import read_source, store_source
from packages.ai.assembly_reader import AssemblyReading
from packages.ai.sketch_parser import SketchMap
from packages.cad.constraint_solver import repeated_engineering_question, sketch_note_pins
from packages.cad.presentation_sheet import LAYOUT_VERSION
from packages.cad.sketch_rectifier import sketch_format

routes = APIRouter(prefix="/drawings/from-sketch", tags=["Sketch to drawing"])
logger = logging.getLogger(__name__)
Wait = Annotated[int, Query(ge=0, le=240)]
Version = Annotated[int, Query(ge=1)]
Key = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=150)]
FINAL = {"released", "needs_review", "failed"}


class Review(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(strict=True, ge=1)
    reading: SketchMap
    review_note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    confirmed: bool = Field(strict=True)
    verified: list[str] = Field(default_factory=list, max_length=500)


def fingerprint(data):
    return hashlib.sha256(
        json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


async def source_upload(request, filename):
    mime = request.headers.get("content-type", "").lower()
    multipart = mime.startswith("multipart/form-data")
    limit = LIMIT + (65536 if multipart else 0)

    async def bounded():
        total = 0
        async for block in request.stream():
            total += len(block)
            if total > limit:
                raise MultiPartException("Choose a photo or scan up to 20 MiB.")
            yield block

    try:
        if multipart:
            form = await MultiPartParser(request.headers, bounded(), max_files=1, max_fields=0).parse()
            try:
                file = form.get("file")
                if not isinstance(file, UploadFile):
                    raise HTTPException(422, "Upload one photo or scan in the file field.")
                data = await file.read(LIMIT + 1)
                filename = filename or file.filename
            finally:
                await form.close()
        else:
            data = b"".join([block async for block in bounded()])
    except MultiPartException as exc:
        raise HTTPException(413 if "20 MiB" in str(exc) else 422, str(exc)) from None
    if len(data) > LIMIT:
        raise HTTPException(413, "Choose a photo or scan up to 20 MiB.")
    try:
        media = await asyncio.to_thread(sketch_format, data)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from None
    filename = filename or ("sketch." + media.split("/")[1])
    if len(filename) > 240 or any(ord(c) < 32 or c in "/\\" for c in filename):
        raise HTTPException(422, "Choose a valid file name.")
    return data, media, filename


def summary(drawing, rev):
    return {
        "drawing_id": str(drawing.id),
        "filename": drawing.original_filename,
        "sha256": drawing.content_sha256,
        "mime": drawing.content_type,
        "version": rev.number,
        "state": rev.state,
        "needs_human_review": rev.state == "needs_review",
        "created_at": rev.created_at,
    }


async def get_revision(db, drawing_id, number=None):
    query = select(Revision).where(Revision.drawing_id == drawing_id)
    query = (
        query.where(Revision.number == number) if number else query.order_by(Revision.number.desc()).limit(1)
    )
    row = await db.scalar(query)
    if row is None:
        raise HTTPException(404, "Sketch revision unavailable.")
    return row


async def detail(drawing_id, version=None):
    async with sessions()() as db:
        r = await get_revision(db, drawing_id, version)
        first = r if r.number == 1 else await get_revision(db, drawing_id, 1)
        drawing = await db.get(Drawing, drawing_id)
        history = await db.execute(
            select(Revision.number, Revision.state, Revision.review_note)
            .where(Revision.drawing_id == drawing_id)
            .order_by(Revision.number.desc())
        )
        evidence = first.evidence or {}
        fields = ["registration", "candidates", "provider", "model"]
        base = f"/drawings/from-sketch/{drawing_id}"
        files = [
            {
                **{k: o[k] for k in ("name", "mime", "size", "sha256")},
                "href": f"{base}/files/{r.number}/{o['name']}",
            }
            for o in (r.files or {}).get("objects", [])
        ]
        solution = r.solution
        if r.state == "needs_review" and solution and r.reading:
            source_checks = sketch_note_pins(SketchMap.model_validate(r.reading))
            engineering_check = any(pin.code == "engineering_note" for pin in source_checks)
            stored = [pin for pin in solution["pins"] if not (
                engineering_check and pin["code"] == "clarify" and repeated_engineering_question(pin["message"])
            )]
            existing = {pin.get("review_key") for pin in stored}
            extra = [pin.model_dump() for pin in source_checks if pin.review_key not in existing and pin.review_key not in r.accepted]
            solution = {**solution, "pins": [*extra, *stored]}
        return {
            **summary(drawing, r),
            "reading": r.reading,
            "evidence": {k: evidence[k] for k in fields if k in evidence},
            "review_note": r.review_note,
            "verified": r.accepted,
            "solution": solution,
            "files": files,
            "part_pages": (r.files or {}).get("part_pages", []),
            "error": r.error,
            "history": [{"version": n, "state": s, "note": note} for n, s, note in history],
            "status_url": f"{base}?version={r.number}",
            "source_url": f"/v1/drawings/{drawing_id}/source",
        }


async def receipt(drawing_id, number, wait, response):
    end = time.monotonic() + wait
    while time.monotonic() < end:
        async with sessions()() as db:
            state = await db.scalar(
                select(Revision.state).where(Revision.drawing_id == drawing_id, Revision.number == number)
            )
        if state in FINAL:
            break
        await asyncio.sleep(min(0.6, max(0, end - time.monotonic())))
    record = await detail(drawing_id, number)
    if record["state"] not in FINAL:
        response.status_code = 202
        response.headers["Retry-After"] = "2"
    response.headers["Location"] = record["status_url"]
    return record


@routes.post("")
async def create(
    request: Request,
    response: Response,
    wait_seconds: Wait = 210,
    review_first: bool = False,
    filename: Annotated[str | None, Query(min_length=1, max_length=240)] = None,
    idempotency_key: Annotated[Key | None, Header(alias="Idempotency-Key")] = None,
):
    """Send a photo as the raw body or multipart field file. Complete readings can release in this call."""
    data, mime, name = await source_upload(request, filename)
    digest = hashlib.sha256(data).hexdigest()
    signature = fingerprint([digest, name, review_first])
    key = "sketch/" + hashlib.sha256((idempotency_key or signature).encode()).hexdigest()
    async with sessions().begin() as db:
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"), {"key": key})
        drawing = await db.scalar(select(Drawing).where(Drawing.drawing_key == key, Drawing.revision == 1))
        if drawing:
            r = await get_revision(db, drawing.id, 1)
            if r.request_hash != signature:
                raise HTTPException(409, "This upload key belongs to a different photo or release request.")
        else:
            obj, version = await asyncio.to_thread(store_source, data, mime)
            drawing = Drawing(
                drawing_key=key,
                revision=1,
                source_type="HAND_SKETCH",
                original_filename=name,
                content_type=mime,
                content_sha256=digest,
                source_key=obj,
                source_version=version,
            )
            db.add(drawing)
            await db.flush()
            db.add(
                Revision(drawing_id=drawing.id, number=1, request_hash=signature, review_first=review_first)
            )
        drawing_id = drawing.id
    return await receipt(drawing_id, 1, wait_seconds, response)


class ProofInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(strict=True, ge=1)
    reading: SketchMap
    verified: list[str] = Field(default_factory=list, max_length=500)


proof_slots = asyncio.Semaphore(2)


@routes.post("/{drawing_id}/proof")
async def compile_proof(drawing_id: UUID, payload: ProofInput):
    from packages.cad.review_proof import blank, sketch_proof
    async with sessions()() as db:
        await get_revision(db, drawing_id, payload.version)
        first = await get_revision(db, drawing_id, 1)
        evidence = first.evidence or {}
    if "registration" not in evidence:
        raise HTTPException(409, "The source photo is still being read.")
    try:
        async with proof_slots:
            return await asyncio.to_thread(sketch_proof,payload.reading,payload.version,evidence,payload.verified)
    except ValueError as exc:
        return blank([str(exc)])


@routes.post("/{drawing_id}/draft")
async def download_draft(drawing_id: UUID, payload: ProofInput):
    from packages.cad.sketch_draft import make_sketch_draft

    async with sessions()() as db:
        await get_revision(db, drawing_id, payload.version)
        first = await get_revision(db, drawing_id, 1)
        evidence = first.evidence or {}
    if not evidence.get("registration") or not evidence.get("page"):
        raise HTTPException(409, "Wait for the photo to finish reading before making a draft.")
    source = evidence["page"]
    reference = None
    assembly_states = [payload.reading.title, *(part.name for part in payload.reading.parts)]
    looks_assembled = any(part.shape == "unknown" for part in payload.reading.parts) or any(
        re.search(r"\b(?:assembly|perspective|isometric|exploded)\b", heading, re.I) for heading in assembly_states
    )
    if looks_assembled:
        try:
            reference = await asyncio.to_thread(saved_assembly, source)
            if reference is None:
                request = await asyncio.to_thread(sketch_assembly_reference.apply_async, args=(str(drawing_id),), retry=False)
                outcome = await asyncio.to_thread(request.get, timeout=155, propagate=False)
                if isinstance(outcome, dict):
                    reference = outcome
                elif isinstance(outcome, Exception):
                    logger.warning("Assembly reader failed for %s (%s)", drawing_id, type(outcome).__name__)
        except (CeleryError, OperationalError, RedisError, OSError, ValueError) as exc:
            logger.warning("Assembly reference unavailable for %s (%s)", drawing_id, type(exc).__name__)
    assembly = AssemblyReading.model_validate(reference["reading"]) if reference else None
    async with proof_slots:
        photo = await asyncio.to_thread(read_source, source["key"], source["version"])
        if hashlib.sha256(photo).hexdigest() != source["sha256"]:
            raise HTTPException(503, "The saved photo preview failed its checksum check.")
        pdf = await asyncio.to_thread(
            make_sketch_draft, payload.reading, payload.version, evidence, photo, payload.verified, assembly=assembly
        )
    return Response(pdf, media_type="application/pdf", headers={
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Assembly-Reference": "pending" if looks_assembled and reference is None else "complete",
        "Content-Disposition": f'attachment; filename="draft-drawing-rev-{payload.version}.pdf"',
    })


def visual_status(row):
    if row is None:
        return {"state": "idle"}
    file = row.file or {}
    asset = file.get("sha256") if "pdf" in file else None
    update_available = bool(asset and file.get("layout_version") != LAYOUT_VERSION)
    if row.state == "ready" and not asset:
        return {"state": "idle"}
    if row.state in ("queued", "rendering") and datetime.now(timezone.utc) - row.started_at > timedelta(minutes=8):
        return {"state": "failed", "error": "The drawing request timed out. Try again.",
                "asset": asset, "update_available": update_available, "audit": file.get("audit")}
    return {"state": row.state, "error": row.error, "asset": asset, "update_available": update_available,
            "audit": file.get("audit")}


@routes.get("/{drawing_id}/visual")
async def show_visual(drawing_id: UUID, version: Version):
    async with sessions()() as db:
        revision = await get_revision(db, drawing_id, version)
        return visual_status(await db.get(SketchVisualPreview, revision.id))


@routes.post("/{drawing_id}/visual", status_code=202)
async def request_visual(drawing_id: UUID, version: Version, redo: bool = False, new_image: bool = False):
    async with sessions().begin() as db:
        revision = await get_revision(db, drawing_id, version)
        if revision.state not in ("needs_review", "released"):
            raise HTTPException(409, "Wait for the sketch to finish reading.")
        revision_id = revision.id
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
                         {"key": "sketch/visual/" + str(revision_id)})
        row = await db.get(SketchVisualPreview, revision_id, with_for_update=True)
        status = visual_status(row)
        if status["state"] in ("queued", "rendering") or (
            status["state"] == "ready" and not (redo or new_image or status["update_available"])
        ):
            return status
        attempt = uuid4()
        values = {"attempt_id": attempt, "state": "queued", "started_at": datetime.now(timezone.utc), "error": None}
        if row is None:
            db.add(SketchVisualPreview(revision_id=revision_id, **values))
        else:
            for field, value in values.items():
                setattr(row, field, value)
    try:
        await asyncio.to_thread(sketch_visual_preview.apply_async,
                                args=(str(revision_id), str(attempt), new_image), retry=False)
    except (CeleryError, OperationalError, OSError):
        async with sessions().begin() as db:
            await db.execute(update(SketchVisualPreview).where(
                SketchVisualPreview.revision_id == revision_id, SketchVisualPreview.attempt_id == attempt,
                SketchVisualPreview.state == "queued",
            ).values(state="failed", error="The visual preview queue is unavailable. Try again."))
        raise HTTPException(503, "The visual preview queue is unavailable. Try again.") from None
    return {"state": "queued", "asset": status.get("asset"), "update_available": status.get("update_available", False),
            "audit": status.get("audit")}


@routes.get("/{drawing_id}/visual/{view}")
async def visual_asset(drawing_id: UUID, view: str, version: Version, download: bool = False):
    if view not in ("image", "pdf"):
        raise HTTPException(404, "Drawing file unavailable.")
    async with sessions()() as db:
        revision = await get_revision(db, drawing_id, version)
        row = await db.get(SketchVisualPreview, revision.id)
        file = row.file if row and row.file else None
        if file and view == "pdf":
            file = file.get("pdf")
        if not file:
            raise HTTPException(404, "Drawing file unavailable.")
    return await send_file(file, download)


@routes.get("")
async def recent(limit: Annotated[int, Query(ge=1, le=150)] = 50):
    inner = (
        select(Revision.id)
        .distinct(Revision.drawing_id)
        .order_by(Revision.drawing_id, Revision.number.desc())
        .subquery()
    )
    query = (
        select(Drawing.id, Drawing.original_filename, Revision.number, Revision.state, Revision.created_at)
        .join(Revision, Revision.drawing_id == Drawing.id)
        .join(inner, inner.c.id == Revision.id)
        .order_by(Revision.created_at.desc())
        .limit(limit)
    )
    async with sessions()() as db:
        return [
            {"drawing_id": str(id), "filename": name, "version": n, "state": state, "created_at": dt}
            for id, name, n, state, dt in await db.execute(query)
        ]


@routes.get("/{drawing_id}")
async def show(drawing_id: UUID, version: Version | None = None):
    return await detail(drawing_id, version)


@routes.post("/{drawing_id}/review")
async def review(drawing_id: UUID, body: Review, response: Response, wait_seconds: Wait = 60):
    sig = fingerprint(body.model_dump(mode="json"))
    async with sessions().begin() as db:
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
            {"key": f"sketch-edit/{drawing_id}"},
        )
        latest = await get_revision(db, drawing_id)
        if latest.number != body.version:
            previous = await db.scalar(
                select(Revision).where(Revision.drawing_id == drawing_id, Revision.number == body.version + 1)
            )
            if previous is None or previous.request_hash != sig:
                raise HTTPException(409, "This sketch has a newer revision. Reopen it before saving.")
            number = previous.number
        else:
            if latest.state not in ("needs_review", "released"):
                raise HTTPException(409, "Wait for the saved reading before reviewing it.")
            new_checks = set(body.verified) - set(latest.accepted)
            if body.review_note == "Checked handwritten dimensions and feature locations against the photo." and any(
                pin["code"] == "engineering_note" and pin.get("review_key") in new_checks
                for pin in (latest.solution or {}).get("pins", [])
            ):
                raise HTTPException(422, "Record the engineering reviewer or approved reference in the review note.")
            number = latest.number + 1
            db.add(
                Revision(
                    drawing_id=drawing_id,
                    number=number,
                    request_hash=sig,
                    review_first=not body.confirmed,
                    review_note=body.review_note,
                    accepted=sorted(set(body.verified)),
                    reading=body.reading.model_dump(mode="json"),
                )
            )
    return await receipt(drawing_id, number, wait_seconds, response)


@routes.post("/{drawing_id}/retry")
async def retry(drawing_id: UUID, response: Response, version: Version, wait_seconds: Wait = 210):
    async with sessions().begin() as db:
        row = await db.scalar(
            select(Revision)
            .where(Revision.drawing_id == drawing_id, Revision.number == version)
            .with_for_update()
        )
        if not row:
            raise HTTPException(404, "Sketch unavailable.")
        if row.state == "failed":
            row.state, row.claimed_at, row.error = "queued", None, None
    return await receipt(drawing_id, version, wait_seconds, response)


async def send_file(obj, download):
    data = await asyncio.to_thread(read_source, obj["key"], obj["version"])
    if hashlib.sha256(data).hexdigest() != obj["sha256"]:
        raise HTTPException(503, "The stored file failed its checksum check.")
    return Response(
        data,
        media_type=obj["mime"],
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": ("attachment" if download else "inline")
            + "; filename*=UTF-8''"
            + quote(obj["name"], safe=""),
        },
    )


@routes.get("/{drawing_id}/preview/{view}")
async def preview(drawing_id: UUID, view: str):
    async with sessions()() as db:
        first = await get_revision(db, drawing_id, 1)
        if view not in ("page", "overlay") or not first.evidence:
            raise HTTPException(404, "Photo preview unavailable.")
        obj = first.evidence[view]
    return await send_file(obj, False)


@routes.get("/{drawing_id}/files/{number}/{name}")
async def artifact(drawing_id: UUID, number: int, name: str):
    async with sessions()() as db:
        if number < 1:
            raise HTTPException(404, "Drawing revision unavailable.")
        row = await get_revision(db, drawing_id, number)
        if row.state != "released":
            raise HTTPException(409, "Resolve the review pins before downloading cut files.")
        obj = next((o for o in row.files["objects"] if o["name"] == name), None)
        if not obj:
            raise HTTPException(404, "Drawing file unavailable.")
    return await send_file(obj, True)
