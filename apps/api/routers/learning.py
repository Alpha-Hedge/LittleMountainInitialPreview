"""Provide saved engineering records to the trusted desk's hosted history sync."""

from typing import Annotated, Literal
from uuid import UUID

from fabrication.config import sessions
from fabrication.drawing_records import record
from fabrication.models import (
    BlueprintQuoteJob,
    Drawing,
    Material,
    NickRule,
    SketchRevision,
    WorkCenter,
)
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import String, cast, literal, select, union_all

routes = APIRouter(prefix="/v1/learning/engineering", tags=["Engineering history"])
Sources = Literal["blueprint", "sketch", "rule", "material", "center"]
MODELS = {
    "blueprint": BlueprintQuoteJob,
    "sketch": SketchRevision,
    "rule": NickRule,
    "material": Material,
    "center": WorkCenter,
}


@routes.get("")
async def index(
    after: Annotated[str, Query(max_length=70)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
):
    # A complete scan also catches records committed after an earlier page was read. The desk
    # restarts at the beginning after every sweep and skips copies with the same stamp.
    rows = []
    for kind, model in MODELS.items():
        stmt = select(
            literal(kind).label("kind"),
            model.id.label("id"),
            (literal(kind + ":") + cast(model.id, String)).label("key"),
            cast(model.updated_at if kind == "blueprint" else model.created_at, String).label("stamp"),
        )
        if kind == "blueprint":
            stmt = stmt.where(model.state.in_(("review_required", "ready")))
        if kind == "sketch":
            stmt = stmt.where(model.state.in_(("needs_review", "released")))
        rows.append(stmt)
    feed = union_all(*rows).subquery()
    async with sessions()() as db:
        batch = await db.execute(
            select(feed).where(feed.c.key > after).order_by(feed.c.key).limit(limit)
        )
        return [dict(row) for row in batch.mappings()]


@routes.get("/{kind}/{item_id}")
async def archive(kind: Sources, item_id: UUID):
    async with sessions()() as db:
        row = await db.get(MODELS[kind], item_id)
        if row is None:
            raise HTTPException(404, "Engineering record unavailable.")
        source = None
        if kind == "blueprint":
            if row.state not in ("review_required", "ready"):
                raise HTTPException(409, "This reading is still processing.")
            drawing = await db.get(Drawing, row.drawing_id)
            data = {
                "id": row.id, "version": row.version, "state": row.state,
                "inputs": {k: v for k, v in row.inputs.items() if k != "hosted_history"},
                "extraction": row.extraction, "reviewed_ast": row.reviewed_ast,
                "review_log": row.review_log, "result": row.result,
                "error": row.error, "updated_at": row.updated_at,
            }
        elif kind == "sketch":
            if row.state not in ("needs_review", "released"):
                raise HTTPException(409, "This sketch is still processing.")
            drawing = await db.get(Drawing, row.drawing_id)
            data = {
                "id": row.id, "number": row.number, "state": row.state,
                "reading": row.reading, "evidence": row.evidence,
                "review_note": row.review_note, "accepted": row.accepted,
                "solution": row.solution, "error": row.error,
                "files": [{"name": f["name"], "sha256": f["sha256"]} for f in (row.files or {}).get("objects", [])],
                "created_at": row.created_at,
            }
        else:
            return {"data": record(row), "source": None}
        source = {
            "id": drawing.id, "type": drawing.source_type, "revision": drawing.revision,
            "file_name": drawing.original_filename, "mime": drawing.content_type,
            "sha256": drawing.content_sha256,
        }
        return {"data": data, "source": source}
