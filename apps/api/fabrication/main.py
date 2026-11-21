"""Loopback-only engineering API. The trusted web server holds its bearer credential."""
import asyncio
import hashlib
import json
import os
import secrets
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated
from urllib.parse import quote as encode_filename
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from redis.asyncio import Redis
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from .cad import routes as cad_routes
from .desk import routes as desk_routes
from .config import redis_url, sessions
from .models import Customer, Drawing, Material, NickRule, Quote, QuoteLineItem, WorkCenter
from .schemas import MaterialInput, QuoteSnapshot, WorkCenterInput
from .storage import BUCKET, read_source, storage
from .drawing_records import record, upload_drawing
from .tasks import verify_original, worker
from .blueprint_jobs import dispatcher
from packages.ai.quote_rag import index_approved_quote
from routers.quotes import routes as blueprint_routes
from routers.nick_rules import routes as rule_routes
from routers.sketches import routes as sketch_routes
from routers.learning import routes as learning_routes


@asynccontextmanager
async def lifespan(_app):
    dispatch = asyncio.create_task(dispatcher())
    try:
        yield
    finally:
        dispatch.cancel()
        with suppress(asyncio.CancelledError):
            await dispatch


app = FastAPI(title="Fabrication Engineering Records", version="3.0.0", lifespan=lifespan)
bearer = HTTPBearer(auto_error=False)


def authenticate(token: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
    if token is None or not secrets.compare_digest(token.credentials.encode(), os.environ["NFIP_API_TOKEN"].encode()):
        raise HTTPException(401, "Server credential required.", headers={"WWW-Authenticate": "Bearer"})


auth = [Depends(authenticate)]
app.include_router(cad_routes, dependencies=auth)
app.include_router(desk_routes, dependencies=auth)
app.include_router(blueprint_routes, dependencies=auth)
app.include_router(rule_routes, dependencies=auth)
app.include_router(sketch_routes, dependencies=auth)
app.include_router(learning_routes, dependencies=auth)


@app.get("/health/ready")
async def readiness():
    try:
        async with sessions()() as db:
            version = await db.scalar(text("SELECT version_num FROM alembic_version"))
        async with Redis.from_url(redis_url(0), socket_connect_timeout=2, socket_timeout=2) as redis:
            await redis.ping()
        exists = await asyncio.wait_for(run_in_threadpool(storage().bucket_exists, BUCKET), 4)
        if version != "0007_sketch_visual_previews" or not exists:
            raise RuntimeError("Initialization pending")
    except Exception:
        raise HTTPException(503, "Engineering storage is unavailable.") from None
    return {"status": "ready", "schema_revision": version}


@app.post("/v1/quote-versions", dependencies=auth)
async def append_quote(payload: QuoteSnapshot, response: Response):
    body = payload.model_dump(mode="json")
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    try:
        async with sessions().begin() as db:
            await db.execute(insert(Customer).values(company_name=payload.customer_name)
                             .on_conflict_do_nothing(index_elements=["company_name"]))
            customer_id, tier = (await db.execute(select(Customer.id, Customer.pricing_tier).where(Customer.company_name == payload.customer_name))).one()
            values = payload.model_dump(exclude={"lines"})
            values["pricing_inputs"].setdefault("customer_tier", tier)
            row_id = await db.scalar(insert(Quote).values(**values, customer_id=customer_id, payload_sha256=digest)
                                     .on_conflict_do_nothing(index_elements=["quote_number", "revision"]).returning(Quote.id))
            already_saved = row_id is None
            if already_saved:
                previous = (await db.execute(select(Quote.id, Quote.payload_sha256).where(
                    Quote.quote_number == payload.quote_number, Quote.revision == payload.revision))).one()
                if previous.payload_sha256 != digest:
                    raise HTTPException(409, "This quote revision is frozen with different inputs.")
                row_id = previous.id
            else:
                for pos, line in enumerate(payload.lines):
                    db.add(QuoteLineItem(quote_id=row_id, position=pos, **line.model_dump()))
                await db.flush()
                response.status_code = 201
            await index_approved_quote(db, row_id)
            await db.execute(text("INSERT INTO preference_jobs(quote_id) VALUES(:id) ON CONFLICT DO NOTHING"), {"id": row_id})
    except IntegrityError:
        raise HTTPException(422, "A referenced work center or drawing does not exist, or the snapshot is invalid.") from None
    return {"id": row_id, "quote_number": payload.quote_number, "revision": payload.revision, "already_saved": already_saved}


@app.get("/v1/quotes/{quote_number}/versions/{revision}", dependencies=auth)
async def read_quote(quote_number: str, revision: int):
    async with sessions()() as db:
        row = await db.scalar(select(Quote).where(Quote.quote_number == quote_number, Quote.revision == revision))
        if row is None:
            raise HTTPException(404, "Quote revision unavailable.")
        lines = await db.scalars(select(QuoteLineItem).where(QuoteLineItem.quote_id == row.id).order_by(QuoteLineItem.position))
        return {**record(row), "lines": [record(line) for line in lines]}


@app.get("/v1/catalog", dependencies=auth)
async def read_catalog(as_of: date | None = None):
    day = as_of or date.today()
    async with sessions()() as db:
        centers = await db.scalars(select(WorkCenter).distinct(WorkCenter.name).where(WorkCenter.effective_on <= day)
                                   .order_by(WorkCenter.name, WorkCenter.effective_on.desc()))
        materials = await db.scalars(select(Material).distinct(Material.spec_code, Material.supplier)
                                     .where(Material.effective_on <= day)
                                     .order_by(Material.spec_code, Material.supplier, Material.effective_on.desc()))
        # Filter AFTER selecting the latest rule to respect a later retirement.
        cutoff = datetime.combine(day, time.min, timezone.utc) + timedelta(days=1)
        latest = (select(NickRule).where(NickRule.status.in_(("approved","retired")), NickRule.created_at < cutoff)
                  .distinct(NickRule.rule_key).order_by(NickRule.rule_key, NickRule.revision.desc()))
        rules = await db.scalars(latest)
        return {"as_of": day, "work_centers": [record(c) for c in centers], "materials": [record(m) for m in materials],
                "nick_rules": [record(r) for r in rules if r.status == "approved"]}


async def add_catalog_item(model, payload):
    try:
        async with sessions().begin() as db:
            item = model(**payload.model_dump())
            db.add(item)
            await db.flush()
            return record(item)
    except IntegrityError:
        raise HTTPException(409, "A rate already exists for this name and effective date.") from None


@app.post("/v1/catalog/work-centers", dependencies=auth, status_code=201)
async def add_work_center(payload: WorkCenterInput):
    return await add_catalog_item(WorkCenter, payload)


@app.post("/v1/catalog/materials", dependencies=auth, status_code=201)
async def add_material(payload: MaterialInput):
    return await add_catalog_item(Material, payload)


app.add_api_route("/v1/drawings", upload_drawing, methods=["POST"], dependencies=auth)


async def get_drawing(drawing_id):
    async with sessions()() as db:
        value = await db.get(Drawing, drawing_id)
        if value is None:
            raise HTTPException(404, "Drawing unavailable.")
        return value


@app.get("/v1/drawings/{drawing_id}", dependencies=auth)
async def drawing_metadata(drawing_id: UUID):
    return record(await get_drawing(drawing_id))


@app.get("/v1/drawings/{drawing_id}/source", dependencies=auth)
async def download_source(drawing_id: UUID):
    drawing = await get_drawing(drawing_id)
    blob = await run_in_threadpool(read_source, drawing.source_key, drawing.source_version)
    if hashlib.sha256(blob).hexdigest() != drawing.content_sha256:
        raise HTTPException(503, "Drawing checksum mismatch.")
    return Response(blob, media_type=drawing.content_type,
                    headers={"Content-Disposition": "attachment; filename*=UTF-8''" + encode_filename(drawing.original_filename, safe=""),
                             "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@app.post("/v1/drawings/{drawing_id}/verify", dependencies=auth, status_code=202)
async def queue_verification(drawing_id: UUID):
    drawing = await get_drawing(drawing_id)
    job = await run_in_threadpool(verify_original.delay, drawing.source_key, drawing.source_version, drawing.content_sha256)
    return {"job_id": job.id}


@app.get("/v1/jobs/{job_id}", dependencies=auth)
def poll_job(job_id: UUID):
    result = worker.AsyncResult(str(job_id))
    return {"state": result.state, "result": result.result if result.successful() else None}

