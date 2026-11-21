"""Rank approved hosted history alongside the engineering ledger. No past rates enter the price."""

from datetime import datetime
from math import log
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from packages.ai.quote_rag import _material, _processes, local_embedding


class HostedLine(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    workspace: UUID
    quote_id: Annotated[str, Field(min_length=1, max_length=120)]
    revision: Annotated[int, Field(ge=1, le=2147483647)]
    line_id: Annotated[str, Field(min_length=1, max_length=120)]
    number: Annotated[str, Field(max_length=120)]
    description: Annotated[str, Field(max_length=500)]
    material: Annotated[str, Field(max_length=200)]
    dimensions: Annotated[str, Field(max_length=200)]
    work: Annotated[list[Annotated[str, Field(max_length=180)]], Field(max_length=25)]
    actuals: Annotated[list[Annotated[str, Field(max_length=220)]], Field(max_length=16)]
    quantity: Annotated[int, Field(ge=1, le=1_000_000_000)]
    approved_at: datetime
    completed_edit: Annotated[int, Field(ge=1, le=2147483647)] | None = None
    scope_changes: Annotated[str, Field(max_length=400)]
    override_reason: Annotated[str, Field(max_length=400)]
    decision: Literal["standard", "one_time", "recurring", "scope_change"]


def matches_hosted(records, *, part, line, as_of, exclude_quote_number=None):
    processes = set(_processes(line["processes"]))
    text = f"{line['description']} {part.outline.width_in or ''} {part.outline.height_in or ''}"
    target = local_embedding(text)
    family = _material(part.material_family)
    distinct = {}
    for record in records:
        if record["number"] == exclude_quote_number or _material(record["material"]) != family:
            continue
        approved = datetime.fromisoformat(record["approved_at"])
        if approved.tzinfo is None or approved > as_of:
            continue
        current = set(_processes(record["work"]))
        overlap = processes & current
        if processes and current and not overlap:
            continue
        similarity = sum(a * b for a, b in zip(
            target, local_embedding(f"{record['description']} {record['dimensions']}"), strict=True
        ))
        scale = abs(log(record["quantity"] / part.quantity))
        score = round(.45 * max(similarity, 0) + .40 * len(overlap) / max(1, len(processes))
                      + .15 / (1 + scale), 6)
        # A commercial discount does not invalidate a measured shop time. Keep that distinction.
        scope = record["scope_changes"]
        typical = record["decision"] != "scope_change" and not scope
        reference = f"{record['workspace']}/{record['quote_id']}/{record['revision']}/{record['line_id']}"
        excerpt = f"Supabase · {record['number']} v{record['revision']} · {record['description']}"
        if record["actuals"]:
            excerpt += " · " + ("Recorded actuals" if typical else "Recorded exception") + ": " + ", ".join(record["actuals"][:4])
        elif record["decision"] == "recurring" and record["override_reason"]:
            excerpt += " · Approved preference: " + record["override_reason"]
        value = {
            "quote_id": record["quote_id"], "quote_number": record["number"], "revision": record["revision"],
            "description": record["description"], "override_reason": record["override_reason"],
            "score": score, "actuals": record["actuals"], "scope_changes": scope, "typical": typical,
            "source_workspace": record["workspace"], "completed_edit": record["completed_edit"],
            "citation": {"kind": "historical_job", "reference": reference, "excerpt": excerpt},
            "ai_proposed": None, "nick_approved": None,
        }
        key = (record["workspace"], record["quote_id"])
        # Prefer the approved revision with recorded actuals, then match quality and recency.
        rank = (bool(record["actuals"]) and typical, score, record["revision"])
        if key not in distinct or rank > distinct[key][0]:
            distinct[key] = (rank, value)
    return [item for _, item in sorted(distinct.values(), key=lambda v: v[0], reverse=True)[:5]]
