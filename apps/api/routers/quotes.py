"""Drawing-to-estimate workspace. All writes require the trusted desk's server credential."""

import asyncio
import hashlib
import json
from datetime import date, datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import load_only

from fabrication.config import sessions
from fabrication.drawing_records import SourceType, upload_drawing
from fabrication.models import BlueprintQuoteJob as Job, Drawing, Material, WorkCenter
from fabrication.storage import read_source, store_sketch_file
from packages.ai.blueprint_extractor import BlueprintError, read_printed_pages, render_blueprint_preview
from packages.ai.callout_recovery import recover_source_facts
from packages.ai.printed_inventory import PRINTED_INVENTORY_VERSION, reconcile_inventory
from packages.ai.schemas import EngineeringAST, EngineeringPart
from packages.ai.hosted_history import HostedLine
from packages.cad.cost_engine import CostSettings, benchmark_demo_settings

routes = APIRouter(prefix="/v1/blueprints", tags=["Blueprint estimates"])
preview_slots = asyncio.Semaphore(2)
Short = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EstimateHistory(Payload):
    hosted_history: list[HostedLine] = Field(default_factory=list, max_length=200)
    hosted_history_status: Literal["local", "supabase", "unavailable"] | None = None


class Generation(EstimateHistory):
    drawing_id: UUID
    request_key: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=8, max_length=160)
    ]
    customer_name: Short = "Customer not entered"
    job_name: Short | None = None
    notes: str = Field(default="", max_length=16000)
    quote_number: str | None = Field(default=None, max_length=100)
    settings: CostSettings | None = None


class Revision(Payload):
    version: int = Field(ge=1, strict=True)


class Review(Revision, EstimateHistory):
    ast: EngineeringAST
    reason: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
    ]
    confirmed: bool = Field(strict=True)
    save_only: bool = Field(default=False, strict=True)
    accepted_low_confidence: list[str] = Field(default_factory=list, max_length=2000)
    settings: CostSettings | None = None
    shop_scope: str | None = Field(default=None, max_length=2000)
    installation: Literal["confirm", "included", "excluded"] | None = None
    scope_decisions: dict[str, Literal["include", "exclude"]] = Field(default_factory=dict, max_length=50)


async def freeze_settings(db, settings, day):
    card = (settings or benchmark_demo_settings()).model_dump(mode="json")
    if card["demo"]:
        return card
    materials = card["materials"]
    for m in materials:
        saved = await db.scalar(
            select(Material)
            .where(
                Material.spec_code == m["spec_code"],
                Material.supplier == m["supplier"],
                Material.effective_on <= day,
            )
            .order_by(Material.effective_on.desc())
            .limit(1)
        )
        if saved:
            m.update(
                cost_per_lb=str(saved.cost_per_lb),
                density_lb_per_in3=str(saved.density_lb_per_in3),
                effective_on=saved.effective_on.isoformat(),
            )
            if saved.k_factor is not None:
                m["k_factor"] = str(saved.k_factor)
    for operation in [card["cut"], card["brake"], *card["welds"]]:
        center = operation["center"]
        saved = await db.scalar(
            select(WorkCenter)
            .where(WorkCenter.name == center["name"], WorkCenter.effective_on <= day)
            .order_by(WorkCenter.effective_on.desc())
            .limit(1)
        )
        if saved:
            center.update(
                hourly_rate=str(saved.hourly_rate),
                setup_minutes=str(saved.default_setup_minutes),
                includes=saved.includes,
                efficiency_factor=str(saved.efficiency_factor),
                effective_on=saved.effective_on.isoformat(),
            )
    effective_dates = [m["effective_on"] for m in materials] + [
        op["center"]["effective_on"]
        for op in [card["cut"], card["brake"], *card["welds"]]
    ]
    if any(date.fromisoformat(d) > day for d in effective_dates):
        raise HTTPException(422, "Choose prices in effect on the estimate date.")
    try:
        return CostSettings.model_validate(card).model_dump(mode="json")
    except ValidationError:
        raise HTTPException(
            422,
            "A catalog rate is outside the supported shop settings. Check the work centers and stock card.",
        ) from None


@routes.get("/settings")
async def default_card():
    return benchmark_demo_settings().model_dump(mode="json")


@routes.post("/drawings")
async def upload(
    request: Request,
    response: Response,
    drawing_key: Annotated[str, Query(min_length=1, max_length=128)],
    revision: Annotated[int, Query(ge=1, le=2147483647)],
    filename: Annotated[str, Query(min_length=1, max_length=255)],
):
    suffix = filename.rsplit(".", 1)[-1].lower()
    if suffix not in ("pdf", "dxf"):
        raise HTTPException(415, "Choose a PDF or DXF drawing.")
    return await upload_drawing(
        request,
        response,
        SourceType.pdf if suffix == "pdf" else SourceType.dxf,
        drawing_key,
        revision,
        filename,
    )


@routes.get("/drawings/{drawing_id}/preview")
async def preview(drawing_id: UUID, page: Annotated[int, Query(ge=1,le=12)] = 1):
    async with sessions()() as db:
        drawing = await db.get(Drawing, drawing_id)
        if not drawing or drawing.source_type not in ("NATIVE_DXF", "CUSTOMER_PDF"):
            raise HTTPException(404, "Drawing unavailable.")
    async with preview_slots:
        blob = await asyncio.to_thread(read_source, drawing.source_key, drawing.source_version)
        if hashlib.sha256(blob).hexdigest() != drawing.content_sha256:
            raise HTTPException(503, "Drawing checksum mismatch.")
        try:
            jpeg, pages = await asyncio.to_thread(render_blueprint_preview, blob, drawing.source_type == "CUSTOMER_PDF", page)
        except BlueprintError as exc:
            raise HTTPException(422, str(exc)) from None
        from packages.cad.review_proof import rectangular_views
        frames = await asyncio.to_thread(rectangular_views,jpeg)
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control":"private, no-store","X-Page-Count":str(pages),
                    "X-Profile-Frames":json.dumps(frames,separators=(",",":"))})


@routes.post("/jobs", status_code=202)
async def start(payload: Generation):
    body = payload.model_dump(mode="json", exclude={"request_key"})
    digest = hashlib.sha256(
        json.dumps({k: v for k, v in body.items() if not k.startswith("hosted_history")},
                   sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    async with sessions().begin() as db:
        drawing = await db.get(Drawing, payload.drawing_id)
        if drawing is None:
            raise HTTPException(404, "Drawing revision unavailable.")
        if drawing.source_type not in ("CUSTOMER_PDF", "NATIVE_DXF"):
            raise HTTPException(415, "Blueprint estimates accept PDF and DXF drawings.")
        body["settings"] = await freeze_settings(
            db, payload.settings, datetime.now(timezone.utc).date()
        )
        body["job_name"] = body["job_name"] or drawing.original_filename
        await db.execute(
            insert(Job)
            .values(
                drawing_id=payload.drawing_id,
                request_key=payload.request_key,
                request_hash=digest,
                inputs=body,
            )
            .on_conflict_do_nothing(index_elements=["request_key"])
        )
        job = await db.scalar(select(Job).where(Job.request_key == payload.request_key))
        if job.request_hash != digest:
            raise HTTPException(
                409, "That request already uses different inputs. Start a new estimate."
            )
        return summary(job, drawing)


def summary(job, drawing):
    return {
        "id": job.id,
        "state": job.state,
        "needs_human_review": job.state == "review_required",
        "version": job.version,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "customer_name": job.inputs["customer_name"],
        "job_name": job.inputs["job_name"],
        "drawing": {
            "id": drawing.id,
            "drawing_key": drawing.drawing_key,
            "filename": drawing.original_filename,
            "revision": drawing.revision,
            "sha256": drawing.content_sha256,
            "type": drawing.source_type,
        },
    }


@routes.get("/jobs")
async def list_jobs(limit: Annotated[int, Query(ge=1, le=100)] = 40):
    async with sessions()() as db:
        pairs = await db.execute(
            select(Job, Drawing)
            .join(Drawing)
            .options(
                load_only(
                    Job.id,
                    Job.version,
                    Job.state,
                    Job.created_at,
                    Job.updated_at,
                    Job.inputs,
                ),
                load_only(
                    Drawing.id,
                    Drawing.drawing_key,
                    Drawing.original_filename,
                    Drawing.revision,
                    Drawing.content_sha256,
                    Drawing.source_type,
                ),
            )
            .order_by(Job.created_at.desc())
            .limit(limit)
        )
        return [summary(j, d) for j, d in pairs]


@routes.get("/jobs/{job_id}")
async def detail(job_id: UUID):
    async with sessions()() as db:
        job = await db.get(Job, job_id)
        if not job:
            raise HTTPException(404, "Estimate unavailable.")
        drawing = await db.get(Drawing, job.drawing_id)
        reading = job.extraction or {}
        coverage = reading.get("coverage") or {}
        last_review = (job.review_log or [{}])[-1]
        flags = [f for f in reading.get("flags", []) if f.get("path") != "source_release_hold"]
        if job.reviewed_ast:
            accepted = set(job.review_log[-1]["accepted_low_confidence"])
            flags = [
                f.model_dump()
                for f in EngineeringAST.model_validate(job.reviewed_ast).review_flags()
                if f.kind != "low_confidence" or f.path not in accepted
            ]
        return {
            **summary(job, drawing),
            "notes": job.inputs["notes"],
            "settings": job.inputs["settings"],
            "ast": job.reviewed_ast or reading.get("ast"),
            "original_ast": reading.get("ast"),
            "flags": flags,
            "model": reading.get("model"),
            "source_check": {"status": coverage.get("status"), "model": coverage.get("audit_model")}
                if coverage.get("status") in ("checked", "incomplete") else None,
            "recovered_fields": (reading.get("coverage") or {}).get("recovered", []),
            "source_callouts": (reading.get("coverage") or {}).get("callouts"),
            "printed_inventory_current": (reading.get("coverage") or {}).get("printed_inventory_version") == PRINTED_INVENTORY_VERSION,
            "scope_decisions": last_review.get("scope_decisions", {}),
            "shop_scope": last_review.get("shop_scope", ""),
            "installation": last_review.get("installation", "confirm"),
            "review_log": job.review_log,
            "result": job.result,
            "error": job.error,
        }


class BlueprintProof(Revision):
    ast: EngineeringAST
    settings: CostSettings | None = None


@routes.post("/jobs/{job_id}/proof")
async def compile_proof(job_id: UUID, payload: BlueprintProof):
    from packages.cad.review_proof import blank, blueprint_proof
    async with sessions()() as db:
        job = await db.get(Job,job_id)
        if not job or payload.version > job.version:
            raise HTTPException(404,"Drawing revision unavailable.")
        card = payload.settings or CostSettings.model_validate(job.inputs["settings"])
        title = job.inputs["job_name"] or "Drawing review"
    try:
        async with preview_slots:
            return await asyncio.to_thread(blueprint_proof,payload.ast,card,title,payload.version)
    except ValueError as exc:
        return blank([str(exc)])


@routes.get("/jobs/{job_id}/shop-files/{version}/{part}")
async def reviewed_shop_file(job_id: UUID,version: int,part: int):
    from routers.sketches import send_file
    from packages.cad.review_proof import blueprint_drawing
    from packages.cad.dxf_compiler import compile_drawing
    async with sessions()() as db:
        job = await db.get(Job,job_id)
        event = next((e for e in (job.review_log if job else []) if e.get("version")==version), None)
        if not event or event.get("save_only") or (job.version==version and job.state!="ready"):
            raise HTTPException(409,"Confirm this drawing revision and finish its estimate first.")
        following = next((e for e in job.review_log if e.get("version")==version+1),{})
        raw_settings = following.get("prior_settings") or job.inputs["settings"]
        title=job.inputs["job_name"] or "Shop drawing"
    ast=EngineeringAST.model_validate(event["ast"])
    verified=set(event["accepted_low_confidence"])
    if any(f.kind!="low_confidence" or f.path not in verified for f in ast.review_flags()):
        raise HTTPException(409,"Resolve the checks on this drawing revision.")
    if not 0<=part<=len(ast.parts): raise HTTPException(404,"Part unavailable.")
    def compile_saved():
        model=blueprint_drawing(ast,CostSettings.model_validate(raw_settings),title,version)
        files=compile_drawing(model)
        return [store_sketch_file(files.pdf,f"rev-{version}-shop.pdf","application/pdf"),
                *(store_sketch_file(data,f"rev-{version}-part-{i:03}.dxf","application/dxf")
                  for i,data in enumerate(files.dxfs,1))]
    key={"job":job_id,"revision":version}
    async with sessions().begin() as db:
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),{"key":f"shop-files/{job_id}/{version}"})
        manifest=await db.scalar(text("SELECT manifest FROM blueprint_shop_files WHERE job_id=:job AND revision=:revision"),key)
        if manifest is None:
            try:
                async with preview_slots: manifest=await asyncio.to_thread(compile_saved)
            except ValueError as exc: raise HTTPException(422,str(exc)) from None
            await db.execute(text("INSERT INTO blueprint_shop_files VALUES (:job,:revision,CAST(:manifest AS jsonb))"),
                             {**key,"manifest":json.dumps(manifest)})
    return await send_file(manifest[part],True)


async def editable(db, job_id, version, states):
    job = await db.scalar(select(Job).where(Job.id == job_id).with_for_update())
    if not job:
        raise HTTPException(404, "Estimate unavailable.")
    if job.version != version or job.state not in states:
        raise HTTPException(
            409, "The saved estimate has changed. Reopen it before continuing."
        )
    return job


def preserve_review_fields(previous, submitted, path="drawing"):
    """Omitted fields cannot silently erase features. Explicit removals are recorded in the review."""
    if isinstance(previous, dict) and isinstance(submitted, dict):
        for key, old in previous.items():
            if key not in submitted and old is not None:
                raise HTTPException(
                    422, f"Review the complete drawing. Missing {path}.{key}."
                )
            if key in submitted:
                preserve_review_fields(old, submitted[key], f"{path}.{key}")
    elif isinstance(previous, list) and isinstance(submitted, list):
        if path.endswith(".evidence"):
            return  # Evidence entries have different location fields for paper, DXF and staff notes.
        if path == "drawing.parts":
            prior_parts = {part["part_id"]: part for part in previous}
            for i, current in enumerate(submitted):
                if current["part_id"] in prior_parts:
                    preserve_review_fields(prior_parts[current["part_id"]], current, f"{path}.{i}")
        else:
            for i, (old, current) in enumerate(zip(previous, submitted)):
                preserve_review_fields(old, current, f"{path}.{i}")


@routes.post("/jobs/{job_id}/review", status_code=202)
async def review(job_id: UUID, payload: Review):
    async with sessions().begin() as db:
        job = await editable(db, job_id, payload.version, {"review_required", "ready"})
        previous = (job.review_log or [{}])[-1]
        callouts = (job.extraction.get("coverage") or {}).get("callouts") or []
        recovered_ids = {item["part_id"] for item in callouts if item["status"] == "recovered"}
        if not payload.scope_decisions.keys() <= recovered_ids:
            raise HTTPException(422, "A scope decision refers to a callout from another drawing.")
        decisions = {**previous.get("scope_decisions", {}), **payload.scope_decisions}
        preserve_review_fields(
            job.reviewed_ast or job.extraction["ast"],
            payload.ast.model_dump(exclude_unset=True),
        )
        received = [part.part_id for part in payload.ast.parts]
        parts = [part for part in payload.ast.parts if decisions.get(part.part_id) != "exclude"]
        present = {part.part_id for part in parts}
        recovered_parts = (job.extraction.get("coverage") or {}).get("source_check_parts", [])
        original_parts = {part["part_id"]: part for part in [*job.extraction["ast"]["parts"], *recovered_parts]}
        for part_id in original_parts:
            if part_id in recovered_ids - present and decisions.get(part_id) != "exclude":
                parts.append(EngineeringPart.model_validate(original_parts[part_id]))
        try:
            reviewed = EngineeringAST.model_validate({**payload.ast.model_dump(mode="python"),"parts":parts})
        except ValidationError:
            raise HTTPException(422, "Review the drawing and its limit of 50 separate parts.") from None
        positions = {part.part_id: i for i, part in enumerate(parts)}
        accepted = set()
        for path in payload.accepted_low_confidence:
            head = path.split(".")
            if len(head) >= 2 and head[0] == "parts" and head[1].isdigit() and int(head[1]) < len(received):
                new_position = positions.get(received[int(head[1])])
                if new_position is not None:
                    accepted.add(".".join(["parts", str(new_position), *head[2:]]))
        flags = reviewed.review_flags()
        low = {f.path for f in flags if f.kind == "low_confidence"}
        blocked = [f.model_dump() for f in flags if f.blocks_pricing and (f.kind != "low_confidence" or f.path not in accepted)]
        if not payload.save_only and (not payload.confirmed or blocked or accepted != low or recovered_ids - decisions.keys()):
            raise HTTPException(422, blocked or "Confirm the flagged readings and whether the recovered components are in scope.")
        ast = reviewed.model_dump(mode="json")
        event = {
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
            "version": job.version + 1,
            "reason": payload.reason,
            "accepted_low_confidence": sorted(accepted & low),
            "save_only": payload.save_only,
            "scope_decisions": decisions,
            "shop_scope": payload.shop_scope.strip() if payload.shop_scope is not None else previous.get("shop_scope", ""),
            "installation": payload.installation or previous.get("installation", "confirm"),
            "ast": ast,
            "prior_settings": job.inputs["settings"],
            "prior_result": job.result,
        }
        if payload.settings:
            job.inputs = {
                **job.inputs,
                "settings": await freeze_settings(
                    db, payload.settings, job.created_at.date()
                ),
            }
        job.review_log = [*job.review_log, event]
        if payload.hosted_history_status is not None:
            job.inputs = {**job.inputs, **payload.model_dump(mode="json", include={"hosted_history", "hosted_history_status"})}
        job.reviewed_ast = ast
        job.result, job.error, job.claimed_at = None, None, None
        job.version += 1
        job.state = "review_required" if payload.save_only else "costing"
        return {"id": job.id, "version": job.version, "state": job.state}


@routes.post("/jobs/{job_id}/source-check")
async def source_check(job_id: UUID, payload: Revision):
    async with sessions()() as db:
        job = await db.get(Job, job_id)
        if not job or job.version != payload.version or job.state not in {"ready", "review_required"}:
            raise HTTPException(409, "Reopen the current drawing review before checking its source.")
        drawing = await db.get(Drawing, job.drawing_id)
        if drawing.source_type != "CUSTOMER_PDF":
            raise HTTPException(422, "Printed callout checks use the original PDF.")
        source_key, source_version, expected = drawing.source_key, drawing.source_version, drawing.content_sha256
    try:
        content = await asyncio.to_thread(read_source, source_key, source_version)
        if hashlib.sha256(content).hexdigest() != expected:
            raise BlueprintError("The original file did not match its saved checksum.")
        pages = await asyncio.to_thread(read_printed_pages, content)
    except BlueprintError as exc:
        raise HTTPException(422, str(exc)) from None
    async with sessions().begin() as db:
        job = await editable(db, job_id, payload.version, {"ready", "review_required"})
        coverage = job.extraction.get("coverage") or {}
        if coverage.get("printed_inventory_version") == PRINTED_INVENTORY_VERSION:
            return {"id": job.id, "version": job.version, "state": job.state}
        ast = EngineeringAST.model_validate(job.reviewed_ast or job.extraction["ast"])
        previous_ast = ast.model_dump(mode="json")
        previous_callouts = coverage.get("callouts") or []
        callouts = reconcile_inventory(ast, pages, prior_callouts=previous_callouts)
        facts = recover_source_facts(ast, pages)
        additions = callouts[len(previous_callouts):]
        new_ids = {item["part_id"] for item in additions if item["status"] == "recovered"}
        extra_checks = any(item["status"] == "review" for item in additions)
        if extra_checks:
            warning = "Printed source callouts remain outside the parts list. Check the AI source review."
            ast.issues = list(dict.fromkeys([warning, *ast.issues]))[:40]
        current = ast.model_dump(mode="json")
        recovered_parts = [*coverage.get("source_check_parts", []), *(part for part in current["parts"] if part["part_id"] in new_ids)]
        job.extraction = {**job.extraction, "coverage": {
            **coverage, "callouts": callouts, "source_check_parts": recovered_parts,
            "recovered": [*coverage.get("recovered", []), *facts],
            "printed_inventory_version": PRINTED_INVENTORY_VERSION,
        }}
        if current != previous_ast:
            previous = (job.review_log or [{}])[-1]
            event = {
                **previous, "version": job.version + 1, "reviewed_at": datetime.now(timezone.utc).isoformat(),
                "reason": "Compared the saved parts list with printed callouts from the original PDF.",
                "action": "printed_callout_check", "added_callouts": len(new_ids),
                "filled_fields": len(facts),
                "accepted_low_confidence": previous.get("accepted_low_confidence", []),
                "save_only": True, "ast": current, "prior_settings": job.inputs["settings"], "prior_result": job.result,
            }
            job.reviewed_ast = current
            job.review_log = [*job.review_log, event]
            job.result, job.error, job.claimed_at = None, None, None
            job.version += 1
            job.state = "review_required"
        return {"id": job.id, "version": job.version, "state": job.state}


@routes.post("/jobs/{job_id}/retry", status_code=202)
async def retry(job_id: UUID, payload: Revision):
    async with sessions().begin() as db:
        job = await editable(db, job_id, payload.version, {"failed"})
        job.state, job.error, job.claimed_at = (
            "costing" if job.extraction else "queued",
            None,
            None,
        )
        job.version += 1
        return {"id": job.id, "version": job.version, "state": job.state}
