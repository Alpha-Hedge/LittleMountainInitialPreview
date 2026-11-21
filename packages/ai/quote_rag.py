"""Search approved, versioned shop records using engineering filters and pgvector.

Search uses exact cosine distance after filtering. Five results means five distinct
quotes, even if a quote has multiple lines or revisions. All weights are per piece.
The approved snapshot is the source of truth; the index is reproducible derived data.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID

from pgvector.sqlalchemy import Vector
from sqlalchemy import ARRAY, Text, bindparam, exists, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from fabrication.models import Customer, NickRule, Quote, QuoteLineItem, QuoteSearchLine

LOCAL_MODEL = "shop-vocabulary-hash-v1:1536"
OPENAI_MODEL = "openai:text-embedding-3-small:1536"
APPROVED_STATES = ("approved", "sent", "accepted", "declined", "expired")
FAMILIES = (
    ("stainless steel", r"\bstainless\b|\b(?:304L?|316L?)(?:SS)?\b|\bSS(?:304L?|316L?)\b"),
    ("aluminum", r"\balumin(?:i)?um\b|\b(?:5052|6061)(?:-?T\d+)?\b"),
    ("carbon steel", r"\b(?:carbon|mild)(?:\s+steel)?\b|\b(?:A36|A500|A572|A1011|1018|1020|CRS|HRS)\b"),
    ("steel", r"\bsteel\b"), ("copper", r"\bcopper\b"), ("brass", r"\bbrass\b"),
)
PROCESSES = {
    "GMAW": r"\b(?:GMAW|MIG)\b", "GTAW": r"\b(?:GTAW|TIG)\b", "FCAW": r"\b(?:FCAW|flux[ -]?core\w*)\b",
    "SMAW": r"\b(?:SMAW|stick weld\w*)\b", "CUT": r"\b(?:cuts?|cutting|laser|plasma|waterjet|saw(?:ing)?)\b",
    "BEND": r"\b(?:bends?|bent|bending|press[ -]?brake|forming)\b", "DRILL": r"\bdrill(?:ed|ing)?\b",
    "WELD": r"\bweld(?:ing|ed|s)?\b",
}


def _material(value, *, preserve_unknown=True):
    if not isinstance(value, str) or not value.strip():
        return None
    for family, pattern in FAMILIES:
        if re.search(pattern, value, re.I):
            return family
    return " ".join(value.lower().split())[:128] if preserve_unknown else None


def _processes(values, *, preserve_unknown=False):
    found = set()
    for value in values:
        if not isinstance(value, str):
            continue
        matches = {name for name, pattern in PROCESSES.items() if re.search(pattern, value, re.I)}
        if not matches and preserve_unknown and value.strip():
            matches.add(value.strip().upper()[:80])
        found.update(matches)
    if found.intersection({"GMAW", "GTAW", "FCAW", "SMAW"}):
        found.discard("WELD")
    return sorted(found)


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str) and len(value) > 90:
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite() or number.copy_abs() > Decimal("1e20") or number.as_tuple().exponent < -30:
        return None
    return number


def _dict(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _fingerprint(line):
    entered = line.entered
    explicit = _dict(entered.get("retrieval"))
    routing = _dict(entered.get("routing"))
    source = _dict(_dict(routing.get("stockSource")).get("material"))
    labeled = re.search(r"(?im)^material(?: / grade)?\s*:\s*([^\r\n]+)", line.description)
    family = (_material(explicit.get("material_family")) or _material(source.get("spec_code"))
              or _material(labeled[1] if labeled else None) or _material(line.description, preserve_unknown=False))
    weight = _number(explicit.get("weight_lb"))
    if weight is None:
        stock = _dict(routing.get("stock"))
        dimensions = [_number(stock.get(key)) for key in ("blankWidth", "blankHeight", "thicknessMm")]
        density = _number(source.get("density_lb_per_in3"))
        if all(v is not None and v > 0 for v in [*dimensions, density]):
            weight = math.prod(dimensions) * density / Decimal("25.4")**3
    if weight is not None and not (0 < weight <= Decimal("1e20")):
        weight = None
    processes = _processes(_list(explicit.get("processes")), preserve_unknown=True)
    if not processes:
        process_text = [line.description]
        for operation in _list(routing.get("operations")):
            process_text.extend((_dict(operation).get("unit"), _dict(operation).get("name")))
        process_text.extend(_dict(row).get("label") for row in _list(entered.get("costRows")))
        processes = _processes(process_text)
    return family, float(weight) if weight is not None else None, processes


def _search_text(description, material, processes):
    return " ".join(str(value) for value in [description[:12000], material, *processes] if value)


def local_embedding(document: str) -> list[float]:
    """Stable signed feature hashing of terms and ordered bigrams, with shop synonyms."""
    normalized = document.casefold()
    for canonical, pattern in (*FAMILIES, *PROCESSES.items()):
        normalized = re.sub(pattern, lambda _: canonical.replace(" ", "_").lower(), normalized, flags=re.I)
    words = re.findall(r"[a-z0-9_]+", normalized)[:2400]
    features = Counter(words or ["empty_document"])
    pair_counts = Counter(zip(words, words[1:]))
    weighted = {word: 1 + math.log(n) for word, n in features.items()}
    weighted.update({" ".join(pair): 0.45 * (1 + math.log(n)) for pair, n in pair_counts.items()})
    vector = [0.0] * 1536
    for feature, mass in weighted.items():
        digest = hashlib.blake2b(feature.encode(), digest_size=8, person=b"lmm-rag1").digest()
        idx = int.from_bytes(digest[:4], "little") % len(vector)
        vector[idx] += mass if digest[-1] & 1 else -mass
    norm = math.sqrt(sum(v * v for v in vector))
    if not norm:
        vector[0] = 1.0
        return vector
    return [v / norm for v in vector]


def embedding_model():
    provider = os.getenv("NFIP_EMBEDDING_PROVIDER", "local").lower()
    if provider == "openai":
        return OPENAI_MODEL
    if provider == "local":
        return LOCAL_MODEL
    raise ValueError("NFIP_EMBEDDING_PROVIDER must be local or openai.")


def _openai_embeddings(documents):
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("The server needs OPENAI_API_KEY for OpenAI embeddings.")
    req = Request("https://api.openai.com/v1/embeddings", data=json.dumps({
        "model": "text-embedding-3-small",
        "input": [doc.encode("utf-8")[:8000].decode("utf-8", errors="ignore") for doc in documents],
        "dimensions": 1536,
    }).encode(), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urlopen(req, timeout=40) as response:
            ordered = sorted(json.load(response)["data"], key=lambda row: row["index"])
            if [r["index"] for r in ordered] != list(range(len(documents))):
                raise ValueError("Incomplete embedding batch.")
            vectors = [row["embedding"] for row in ordered]
    except (HTTPError, URLError, OSError, ValueError, KeyError, IndexError, TypeError):
        raise RuntimeError("OpenAI embedding service unavailable or returned an invalid result.") from None
    for vector in vectors:
        if not isinstance(vector, list) or len(vector) != 1536 or not all(
            type(v) in (int, float) and math.isfinite(v) for v in vector
        ) or not any(vector):
            raise ValueError("Invalid embedding dimensions or values.")
    return vectors


async def _embed(document, model):
    if model == LOCAL_MODEL:
        return local_embedding(document)
    if model == OPENAI_MODEL:
        return (await asyncio.to_thread(_openai_embeddings, [document]))[0]
    raise ValueError("Unknown embedding model namespace.")


async def index_approved_quote(db: AsyncSession, quote_id: UUID, *, model: str = LOCAL_MODEL) -> int:
    """Called in the approval transaction. Default path has no network dependency."""
    quote = await db.get(Quote, quote_id)
    if not quote or quote.status not in APPROVED_STATES:
        return 0
    already_indexed = exists(select(QuoteSearchLine.id).where(
        QuoteSearchLine.line_id == QuoteLineItem.id, QuoteSearchLine.embedding_model == model))
    lines = await db.scalars(select(QuoteLineItem).where(
        QuoteLineItem.quote_id == quote_id, QuoteLineItem.nick_approved.is_not(None), ~already_indexed))
    count = 0
    for line in lines:
        family, weight, processes = _fingerprint(line)
        document = _search_text(line.description, family, processes)
        statement = insert(QuoteSearchLine).values(
            quote_id=quote.id, line_id=line.id, material_family=family, weight_lb=weight,
            processes=processes, embedding_model=model, embedding=await _embed(document, model),
        ).on_conflict_do_nothing(index_elements=["line_id", "embedding_model"]).returning(QuoteSearchLine.id)
        count += int(await db.scalar(statement) is not None)
    return count


async def backfill(session_factory, model):
    """Keyset-paged, retryable backfill of already archived approvals."""
    cursor = None
    total = 0
    while True:
        async with session_factory.begin() as db:
            fingerprint = exists(select(QuoteSearchLine.id).where(
                QuoteSearchLine.line_id == QuoteLineItem.id, QuoteSearchLine.embedding_model == model))
            missing = exists(select(QuoteLineItem.id).where(QuoteLineItem.quote_id == Quote.id,
                             QuoteLineItem.nick_approved.is_not(None), ~fingerprint))
            q = select(Quote.id).where(Quote.status.in_(APPROVED_STATES), missing).order_by(Quote.id).limit(50)
            if cursor:
                q = q.where(Quote.id > cursor)
            ids = list(await db.scalars(q))
        if not ids:
            return total
        for quote_id in ids:
            async with session_factory.begin() as db:
                total += await index_approved_quote(db, quote_id, model=model)
        cursor = ids[-1]


async def _prepare_query_vector(db, query, as_of):
    model = embedding_model()
    if model == LOCAL_MODEL:
        return model, local_embedding(query), []
    # Approvals always finish locally. Catch hosted embeddings up one bounded batch
    # per query. If the archive is larger, use the complete offline space until all
    # rows have cloud vectors. Never compare vectors from different models.
    remote = aliased(QuoteSearchLine)
    present = exists(select(remote.id).where(remote.line_id == QuoteSearchLine.line_id,
                                              remote.embedding_model == OPENAI_MODEL))
    missing = list((await db.execute(select(QuoteSearchLine, QuoteLineItem.description)
                   .join(QuoteLineItem, QuoteLineItem.id == QuoteSearchLine.line_id)
                   .join(Quote, Quote.id == QuoteSearchLine.quote_id)
                   .where(QuoteSearchLine.embedding_model == LOCAL_MODEL, Quote.created_at <= as_of, ~present)
                   .order_by(QuoteSearchLine.line_id).limit(17))).all())
    batch = missing[:16]
    docs = [_search_text(desc, row.material_family, row.processes) for row, desc in batch]
    try:
        vectors = await asyncio.to_thread(_openai_embeddings, [*docs, query])
    except (RuntimeError, ValueError):
        return LOCAL_MODEL, local_embedding(query), ["Hosted embeddings unavailable. Used the local shop index."]
    for (row, _), vec in zip(batch, vectors[:-1], strict=True):
        await db.execute(insert(QuoteSearchLine).values(
            quote_id=row.quote_id, line_id=row.line_id, material_family=row.material_family, weight_lb=row.weight_lb,
            processes=row.processes, embedding_model=model, embedding=vec,
        ).on_conflict_do_nothing(index_elements=["line_id", "embedding_model"]))
    if len(batch) < len(missing):
        return LOCAL_MODEL, local_embedding(query), ["Building hosted embeddings. Used the complete local shop index."]
    return model, vectors[-1], []


CONDITIONS = {"material_family", "processes", "customer_name", "customer_tier", "thickness_in", "min_quantity", "max_quantity",
              "min_weight_lb", "max_weight_lb"}
CATEGORIES = {"material", "cut", "bend", "weld", "filler", "gas", "allowance", "outside", "other"}
STAGES = {"setup", "run", "stock", "consumable"}


def validate_rule(condition: dict, adjustment: dict):
    """Small declarative grammar: no executable expression or user-selected field path."""
    if not isinstance(condition, dict) or condition.keys() - CONDITIONS:
        raise ValueError("Unknown rule condition.")
    if "thickness_in" in condition and (_number(condition["thickness_in"]) or 0) <= 0:
        raise ValueError("Thickness must be positive inches.")
    for name in ("material_family", "customer_name", "customer_tier"):
        if name in condition and not (isinstance(condition[name], str) and 0 < len(condition[name].strip()) <= 500):
            raise ValueError(f"Provide a nonempty {name}.")
    if "processes" in condition:
        values = condition["processes"]
        if not isinstance(values, list) or not (0 < len(values) <= 32) or not all(
            isinstance(v, str) and 0 < len(v.strip()) <= 80 for v in values
        ):
            raise ValueError("Provide one or more process names.")
    for field in ("quantity", "weight_lb"):
        lower, upper = (condition.get(f"{side}_{field}") for side in ("min", "max"))
        for side, raw in (("min", lower), ("max", upper)):
            if f"{side}_{field}" in condition:
                n = _number(raw)
                if n is None or n <= 0 or (field == "quantity" and n != n.to_integral_value()):
                    raise ValueError(f"Invalid {field} bound.")
        if lower is not None and upper is not None and _number(lower) > _number(upper):
            raise ValueError(f"Reversed {field} bounds.")
    if not isinstance(adjustment, dict):
        raise ValueError("Provide a rule adjustment.")
    if adjustment.get("kind") == "set_margin_pct" and set(adjustment) == {"kind", "value"}:
        value = _number(adjustment["value"])
        if value is not None and 0 <= value < 100 and value == value.quantize(Decimal("0.0001")):
            return
    if "work_center" in adjustment and not (isinstance(adjustment["work_center"],str) and 0<len(adjustment["work_center"].strip())<=160):
        raise ValueError("Provide a work-center name.")
    if adjustment.get("kind") in ("fill_amount","fill_rate"):
        value=_number(adjustment.get("value"))
        if (set(adjustment)-{"work_center"}=={"kind","category","stage","basis","value"}
                and isinstance(adjustment.get("category"),str) and adjustment["category"] in CATEGORIES
                and isinstance(adjustment.get("stage"),str) and adjustment["stage"] in STAGES
                and adjustment.get("basis") in ("batch","per_unit") and value is not None and 0<value<=Decimal("1e9")):
            return
    if adjustment.get("kind") in ("multiply_amount","multiply_rate") and (
        set(adjustment)-{"work_center"} in ({"kind", "category", "factor"}, {"kind", "stage", "category", "factor"})
    ):
        factor = _number(adjustment["factor"])
        if (type(adjustment["category"]) is str and adjustment["category"] in CATEGORIES
                and ("stage" not in adjustment or type(adjustment["stage"]) is str and adjustment["stage"] in STAGES)
                and factor is not None and 0 <= factor <= 10):
            return
    raise ValueError("Unsupported adjustment, category, stage, margin, or multiplier.")


def _matches(condition, *, family, weight, processes, customer, quantity, thickness_in=None, customer_tier=None):
    if "thickness_in" in condition and _number(condition["thickness_in"]) != _number(thickness_in):
        return False
    if "customer_tier" in condition and condition["customer_tier"].casefold() != (customer_tier or "").casefold():
        return False
    if "material_family" in condition and _material(condition["material_family"]) != family:
        return False
    if "processes" in condition and not set(_processes(condition["processes"], preserve_unknown=True)) <= set(processes):
        return False
    if "customer_name" in condition and (customer or "").casefold().strip() != condition["customer_name"].casefold().strip():
        return False
    for field, raw in (("weight_lb", weight), ("quantity", quantity)):
        value = _number(raw)
        if f"min_{field}" in condition and (value is None or value < _number(condition[f"min_{field}"])):
            return False
        if f"max_{field}" in condition and (value is None or value > _number(condition[f"max_{field}"])):
            return False
    return True


async def _active_rules(db, as_of, **context):
    latest = (select(NickRule).distinct(NickRule.rule_key)
              .where(NickRule.created_at <= as_of, NickRule.status.in_(["approved", "retired"]))
              .order_by(NickRule.rule_key, NickRule.revision.desc()))
    rules, warnings = [], []
    for row in await db.scalars(latest):
        if row.status != "approved":
            continue
        try:
            validate_rule(row.condition_json, row.adjustment)
        except ValueError as exc:
            warnings.append(f"Skipped unsupported rule {row.rule_key} v{row.revision}: {exc}")
            continue
        if not _matches(row.condition_json, **context):
            continue
        rules.append({"id": str(row.id), "rule_key": row.rule_key, "revision": row.revision,
                      "condition": row.condition_json, "adjustment": row.adjustment, "rationale": row.rationale,
                      "citation": {"kind": "nick_rule", "reference": str(row.id),
                                   "excerpt": f"{row.rule_key} v{row.revision}: {row.rationale}"}})
    return rules, warnings


def _fields(source, names):
    fields = {}
    for name in names:
        value = _dict(source).get(name)
        if isinstance(value, str):
            fields[name] = value[:240]
        elif type(value) in (float, int, bool):
            fields[name] = value
    return fields


def _evidence_summary(source):
    if source is None:
        return None
    summary = _fields(source, ("hours", "cost", "quantity", "estimatedCost", "sellingPrice",
                               "estimated_cost_usd", "selling_price_usd"))
    blueprint = _dict(source.get("blueprint"))
    if blueprint:
        summary.update(_fields(blueprint, ("part_id", "quantity", "estimated_cost_usd", "selling_price_usd")))
    operations = _list(source.get("operations"))
    if operations:
        summary["operations"] = [_fields(op, ("operationId", "rowId", "hours", "basis", "assumption"))
                                 for op in operations[:32]]
        summary["operation_count"] = len(operations)
    rows = _list(source.get("costRows")) or _list(blueprint.get("rows"))
    if rows:
        columns = ("id", "category", "stage", "label", "amount", "rate", "basis", "unit", "cost_usd")
        summary["rows"] = [_fields(row, columns) for row in rows[:32]]
        summary["row_count"] = len(rows)
    return summary


async def retrieve_context(db: AsyncSession, *, description: str, material_family: str | None,
                           weight_lb: float | None, processes: list[str], as_of: datetime,
                           exclude_quote_number: str | None = None, exclude_drawing_id: UUID | None = None,
                           customer_name: str | None = None, quantity: int | None = None, thickness_in: float | None = None) -> dict:
    if as_of.tzinfo is None or as_of.utcoffset() is None:
        raise ValueError("An explicit timezone is required for historical retrieval.")
    family = _material(material_family)
    required = _processes(processes, preserve_unknown=True)
    if weight_lb is not None and (_number(weight_lb) is None or _number(weight_lb) <= 0):
        raise ValueError("weight_lb must be positive and finite.")
    weight = float(weight_lb) if weight_lb is not None else None
    query = _search_text(description, family, required)
    model, vector, embedding_warnings = await _prepare_query_vector(db, query, as_of)
    bindings = {"as_of": as_of, "model": model, "embedding": vector}
    filters = ["s.embedding_model = :model"]
    if family:
        filters.append("s.material_family = :family")
        bindings["family"] = family
    if weight is not None:
        filters.append("s.weight_lb BETWEEN :minimum_weight AND :maximum_weight")
        bindings.update(minimum_weight=weight / 2, maximum_weight=weight * 2)
    if required:
        filters.append("s.processes @> CAST(:processes AS text[])")
        bindings["processes"] = required
    if exclude_quote_number:
        filters.append("q.quote_number <> :exclude_quote")
        bindings["exclude_quote"] = exclude_quote_number
    if exclude_drawing_id:
        filters.append("""NOT EXISTS (SELECT 1 FROM drawings a JOIN drawings b
            ON (a.drawing_key=b.drawing_key OR a.content_sha256=b.content_sha256)
            WHERE a.id=:exclude_drawing AND b.id=q.drawing_id)""")
        bindings["exclude_drawing"] = exclude_drawing_id
    # Latest approved revision per quote at the cutoff, BEFORE filtering for material/process.
    # Ranking is exact, so filtered ANN candidate starvation cannot remove eligible evidence.
    statement = text("""
        WITH latest AS (
            SELECT DISTINCT ON (quote_number) id, quote_number, revision, drawing_id, created_at, job_name,
                pricing_inputs #> '{details,pricingDecision}' AS pricing_decision
            FROM quotes WHERE status IN ('approved','sent','accepted','declined','expired')
                AND created_at <= :as_of
            ORDER BY quote_number, revision DESC
        ), ranked AS (
            SELECT q.id AS quote_id, q.quote_number, q.revision, q.job_name, q.created_at AS recorded_at,
                q.pricing_decision, l.id AS line_id, l.line_key, l.description, l.quantity,
                l.ai_proposed, l.nick_approved, l.override_reason, l.basis, l.confidence_score,
                s.material_family, s.weight_lb, s.processes,
                CASE WHEN s.weight_lb IS NULL THEN NULL
                     WHEN l.entered #>> '{retrieval,weight_lb}' IS NOT NULL THEN 'recorded per-piece weight'
                     ELSE 'gross rectangular blank weight' END AS weight_basis,
                s.embedding <=> :embedding AS distance,
                row_number() OVER (PARTITION BY q.id ORDER BY s.embedding <=> :embedding, l.position) AS rank
            FROM latest q JOIN quote_search_lines s ON q.id=s.quote_id
                JOIN quote_line_items l ON l.id=s.line_id AND l.quote_id=q.id
            WHERE """ + " AND ".join(filters) + """
        ) SELECT * FROM ranked WHERE rank=1 AND distance < 1
          ORDER BY distance, recorded_at DESC, quote_number LIMIT 5
    """).bindparams(bindparam("embedding", type_=Vector(1536)))
    if required:
        statement = statement.bindparams(bindparam("processes", type_=ARRAY(Text)))
    records = []
    for hit in (await db.execute(statement, bindings)).mappings():
        record = dict(hit)
        del record["rank"]
        score = round(1 - record.pop("distance"), 6)
        # Keep evidence bounded on repeated generations; full originals can always
        # be reopened by immutable revision and line identifiers.
        for key in ("ai_proposed", "nick_approved"):
            record[key] = _evidence_summary(record[key])
        record["pricing_decision"] = _fields(record["pricing_decision"], ("kind", "reason"))
        record["description"] = record["description"][:1200]
        record["override_reason"] = record["override_reason"][:2000]
        record["basis"] = record["basis"][:1200]
        record.update(quote_id=str(hit["quote_id"]), line_id=str(hit["line_id"]),
                      recorded_at=hit["recorded_at"].isoformat(), similarity=score, score=score,
                      confidence_score=str(hit["confidence_score"]) if hit["confidence_score"] is not None else None,
                      citation={"kind": "historical_job", "reference": f"{hit['quote_id']}/{hit['line_id']}",
                                "excerpt": f"{hit['quote_number']} v{hit['revision']}: {hit['description'][:350]}"})
        records.append(record)
    tier = await db.scalar(select(Customer.pricing_tier).where(Customer.company_name == customer_name)) if customer_name else None
    rules, warnings = await _active_rules(db, as_of, family=family, weight=weight, processes=required,
                                          customer=customer_name, quantity=quantity,thickness_in=thickness_in,customer_tier=tier or "STANDARD")
    return {"historical_quotes": records, "rules": rules, "warnings": embedding_warnings + warnings, "embedding_model": model,
            "filters": {"material_family": family, "weight_bracket_lb": [weight / 2, weight * 2] if weight else None,
                        "required_processes": required, "as_of": as_of.isoformat()}}


def resolve_margin(base_margin_pct, contexts):
    """A commercial margin applies once to the quote. Competing values need staff review."""
    proposals = {_number(rule["adjustment"]["value"]) for context in contexts for rule in context.get("rules", [])
                 if rule["adjustment"]["kind"] == "set_margin_pct"}
    if len(proposals) > 1:
        return str(base_margin_pct), ["Conflicting margin rules. The entered margin was kept for staff review."]
    return str(next(iter(proposals), base_margin_pct)), []


def apply_rules(*, cost_rows: list[dict], margin_pct, rules: list[dict]) -> dict:
    """Apply evidence-bearing rules to physical units; current rates and arithmetic stay in the cost engine."""
    adjusted, applied, warnings = [], {}, []
    margin, margin_warnings = resolve_margin(margin_pct, [{"rules": rules}])
    warnings.extend(margin_warnings)
    for rule in rules:
        validate_rule(rule["condition"], rule["adjustment"])
        if rule["adjustment"]["kind"] == "set_margin_pct" and not margin_warnings:
            applied[rule["id"]] = rule["citation"]
    for row in cost_rows:
        output = dict(row)
        for kind, field in (("multiply_amount","amount"),("multiply_rate","rate")):
            matches = [r for r in rules if (r["adjustment"]["kind"] == kind or (
                       r["adjustment"]["kind"]=="fill_"+field and _number(row[field])==0 and
                       r["adjustment"]["basis"]==row.get("basis","batch")))
                       and r["adjustment"]["category"] == row["category"]
                       and r["adjustment"].get("stage", row["stage"]) == row["stage"]
                       and ("work_center" not in r["adjustment"] or r["adjustment"]["work_center"].casefold()==(row.get("work_center") or "").casefold())]
            if len(matches)>1:
                names=", ".join(r["rule_key"] for r in matches)
                warnings.append(f"Overlapping {'quantity' if field=='amount' else 'rate'} rules for {row['category']} {row['stage']} ({names}). The calculated {field} was kept for staff review.")
            elif matches:
                rule=matches[0]
                output[field+"_before_rule"]=str(row[field])
                a=rule["adjustment"]
                value=_number(a["value"]) if a["kind"].startswith("fill_") else Decimal(str(row[field]))*_number(a["factor"])
                output[field]=format(value,"f")
                output["rule_citations"]=[*output.get("rule_citations",[]),rule["citation"]]
                applied[rule["id"]]=rule["citation"]
        adjusted.append(output)
    return {"cost_rows": adjusted, "margin_pct": margin, "applied_rules": list(applied.values()), "warnings": warnings}


if __name__ == "__main__":
    import argparse
    from fabrication.config import sessions

    parser = argparse.ArgumentParser(description="Index immutable approved quote revisions for similar-job search.")
    parser.add_argument("command", choices=["index"])
    parser.parse_args()
    chosen = embedding_model()
    print(f"Indexed {asyncio.run(backfill(sessions(), chosen))} approved lines with {chosen}.")
