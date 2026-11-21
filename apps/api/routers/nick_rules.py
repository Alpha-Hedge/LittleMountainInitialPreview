"""Append-only rule revisions. Mounted with the desk's server authentication."""
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import Field, StringConstraints, model_validator
from sqlalchemy import func, select, text

from fabrication.config import sessions
from fabrication.models import NickRule
from fabrication.schemas import Citation, Input, Key, Object, Text
from packages.ai.quote_rag import validate_rule

routes = APIRouter(prefix="/v1/catalog/nick-rules", tags=["Nick's estimating rules"])
Actor = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=180)]
Revision = Annotated[int, Field(strict=True, ge=0, le=2147483646)]


class RuleInput(Input):
    rule_key: Key
    expected_revision: Revision
    rule_category: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    condition_json: Object
    adjustment: Object
    rationale: Text
    citations: list[Citation] = Field(default_factory=list, max_length=100)
    status: Literal["proposed", "approved"]
    approved_by: Actor | None = None

    @model_validator(mode="after")
    def validate_body(self):
        validate_rule(self.condition_json, self.adjustment)
        if (self.status == "approved") != (self.approved_by is not None):
            raise ValueError("Record who approved the rule on an approved revision.")
        return self


class Retirement(Input):
    expected_revision: Annotated[int, Field(strict=True, ge=1, le=2147483646)]
    retired_by: Actor
    reason: Text


def _record(row):
    return {k: getattr(row, k) for k in ("id", "rule_key", "revision", "created_at", "rule_category",
                                          "condition_json", "adjustment", "rationale", "citations", "status", "approved_by")}


async def _latest_locked(db, key):
    if key.startswith("PREF-"):
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('shop-preference-distillation'))"))
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"), {"key": "rule/" + key})
    return await db.scalar(select(NickRule).where(NickRule.rule_key == key).order_by(NickRule.revision.desc()).limit(1))


@routes.get("")
async def active_rules():
    heads = select(NickRule.rule_key, func.max(NickRule.revision).label("latest")).group_by(NickRule.rule_key).subquery()
    stmt = (select(NickRule, heads.c.latest).join(heads, heads.c.rule_key == NickRule.rule_key)
            .where(NickRule.status.in_(["approved", "retired"]))
            .distinct(NickRule.rule_key).order_by(NickRule.rule_key, NickRule.revision.desc()))
    async with sessions()() as db:
        return [{**_record(row), "latest_revision": latest} for row, latest in (await db.execute(stmt)).all()
                if row.status == "approved"]


@routes.post("")
async def append_rule(payload: RuleInput, response: Response):
    values = payload.model_dump(mode="json", exclude={"expected_revision"})
    async with sessions().begin() as db:
        current = await _latest_locked(db, payload.rule_key)
        if current and current.revision == payload.expected_revision + 1:
            if all(getattr(current, field) == value for field, value in values.items()):
                return _record(current)
        if (current.revision if current else 0) != payload.expected_revision:
            raise HTTPException(409, "A newer rule revision exists. Read the rule and review your changes.")
        row = NickRule(revision=payload.expected_revision + 1, **values)
        db.add(row)
        await db.flush()
        response.status_code = 201
        return _record(row)


@routes.get("/suggestions")
async def suggestions():
    heads=select(NickRule).distinct(NickRule.rule_key).order_by(NickRule.rule_key,NickRule.revision.desc())
    async with sessions()() as db:
        return [_record(r) for r in await db.scalars(heads) if r.status=="proposed"]


class Decision(Input):
    expected_revision: Annotated[int,Field(strict=True,ge=1)]
    action: Literal["approve","dismiss"]
    reviewer: Actor


@routes.post("/{rule_key}/decision")
async def decide(rule_key: Key,payload:Decision):
    status="approved" if payload.action=="approve" else "retired"
    async with sessions().begin() as db:
        prior=await _latest_locked(db,rule_key)
        if not prior: raise HTTPException(404,"Suggestion unavailable.")
        if prior.revision==payload.expected_revision+1 and prior.status==status and prior.approved_by==payload.reviewer:
            return _record(prior)
        if prior.revision!=payload.expected_revision or prior.status!="proposed": raise HTTPException(409,"The evidence has changed. Reopen the suggestion.")
        row=NickRule(rule_key=rule_key,revision=prior.revision+1,rule_category=prior.rule_category,
                     condition_json=prior.condition_json,adjustment=prior.adjustment,citations=prior.citations,
                     rationale=prior.rationale,status=status,approved_by=payload.reviewer)
        db.add(row)
        await db.flush()
        return _record(row)


@routes.post("/{rule_key}/retire")
async def retire_rule(rule_key: Key, payload: Retirement, response: Response):
    async with sessions().begin() as db:
        current = await _latest_locked(db, rule_key)
        if not current:
            raise HTTPException(404, "Rule unavailable.")
        if (current.revision == payload.expected_revision + 1 and current.status == "retired"
                and current.approved_by == payload.retired_by and current.rationale == payload.reason):
            return _record(current)
        if current.revision != payload.expected_revision or current.status == "retired":
            raise HTTPException(409, "This rule changed. Reopen its history.")
        row = NickRule(rule_key=rule_key, revision=current.revision + 1, rule_category=current.rule_category,
                       condition_json=current.condition_json, adjustment=current.adjustment, citations=current.citations,
                       status="retired", approved_by=payload.retired_by, rationale=payload.reason)
        db.add(row)
        await db.flush()
        response.status_code = 201
        return _record(row)


@routes.get("/{rule_key}/versions")
async def rule_history(rule_key: Key):
    async with sessions()() as db:
        rows = await db.scalars(select(NickRule).where(NickRule.rule_key == rule_key).order_by(NickRule.revision.desc()))
        versions = [_record(row) for row in rows]
        if not versions:
            raise HTTPException(404, "Rule unavailable.")
        return versions
