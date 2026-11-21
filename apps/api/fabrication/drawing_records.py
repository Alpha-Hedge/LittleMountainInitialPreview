"""Persist the exact original bytes and seal a single immutable drawing revision."""

import hashlib
from enum import StrEnum
from typing import Annotated
from fastapi import HTTPException, Query, Request, Response
from sqlalchemy import select, text
from starlette.concurrency import run_in_threadpool
from .config import sessions
from .models import Drawing
from .storage import store_source

LIMIT = 20 * 1024 * 1024


def record(row):
    return {
        field.name: getattr(row, field.name)
        for field in row.__table__.columns
        if field.name not in {"job_embedding", "rule_embedding", "payload_sha256"}
    }


class SourceType(StrEnum):
    sketch = "HAND_SKETCH"
    pdf = "CUSTOMER_PDF"
    image = "CUSTOMER_IMAGE"
    dxf = "NATIVE_DXF"
    dwg = "NATIVE_DWG"
    step = "STEP"


async def upload_drawing(
    request: Request,
    response: Response,
    source_type: SourceType,
    drawing_key: Annotated[str, Query(min_length=1, max_length=128)],
    revision: Annotated[int, Query(ge=1, le=2147483647)],
    filename: Annotated[str, Query(min_length=1, max_length=255)],
):
    mime = (
        request.headers.get("content-type", "application/octet-stream")
        .split(";")[0]
        .strip()
    )
    if len(mime) > 100 or any(ord(c) < 32 for c in filename + mime):
        raise HTTPException(422, "Invalid file metadata.")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > LIMIT:
            raise HTTPException(413, "Drawing exceeds 20 MiB.")
        data.extend(chunk)
    if not data:
        raise HTTPException(422, "Drawing is empty.")
    if request.url.path == "/v1/blueprints/drawings":
        if source_type == SourceType.pdf:
            if b"%PDF-" not in data[:1024]:
                raise HTTPException(415, "This file does not have a PDF header.")
            mime = "application/pdf"
        else:
            header = bytes(data[:4096]).lstrip()
            if b"AutoCAD Binary DXF" not in header and b"SECTION" not in header.upper():
                raise HTTPException(
                    415, "This file does not have a DXF section header."
                )
            mime = "application/dxf"
    digest = hashlib.sha256(data).hexdigest()
    async with sessions().begin() as db:
        # Serialize retries of a logical revision before writing a versioned object.
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:k,0))"),
            {"k": f"drawing/{drawing_key}/{revision}"},
        )
        existing = await db.scalar(
            select(Drawing).where(
                Drawing.drawing_key == drawing_key, Drawing.revision == revision
            )
        )
        if existing:
            if (
                existing.content_sha256,
                existing.original_filename,
                existing.source_type,
                existing.content_type,
            ) != (digest, filename, source_type.value, mime):
                raise HTTPException(409, "Use a new revision for a changed drawing.")
            return record(existing)
        key, version = await run_in_threadpool(store_source, bytes(data), mime)
        drawing = Drawing(
            drawing_key=drawing_key,
            revision=revision,
            source_type=source_type.value,
            original_filename=filename,
            content_type=mime,
            content_sha256=digest,
            source_key=key,
            source_version=version,
        )
        db.add(drawing)
        await db.flush()
        response.status_code = 201
        return record(drawing)
