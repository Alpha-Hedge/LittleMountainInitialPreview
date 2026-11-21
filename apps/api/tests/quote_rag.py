"""PostgreSQL 16 + real pgvector integration checks. Fixtures roll back together."""
import asyncio
import hashlib
import math
import os
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch
from uuid import uuid4

from fabrication.config import sessions
from fabrication.models import Customer, Drawing, NickRule, Quote, QuoteLineItem
from packages.ai.quote_rag import (
    LOCAL_MODEL, OPENAI_MODEL, apply_rules, index_approved_quote, local_embedding, resolve_margin, retrieve_context, validate_rule,
)

EARLY = datetime(2022, 1, 1, tzinfo=timezone.utc)
CUTOFF = datetime(2023, 1, 1, tzinfo=timezone.utc)
FUTURE = datetime(2024, 1, 1, tzinfo=timezone.utc)


class RuleTests(unittest.TestCase):
    def test_unsafe_rules_fail_closed(self):
        for cond, adj in [
            ({"random_field": "steel"}, {"kind": "set_margin_pct", "value": 20}),
            ({"min_quantity": True}, {"kind": "set_margin_pct", "value": 20}),
            ({"min_quantity": 5, "max_quantity": 1}, {"kind": "set_margin_pct", "value": 20}),
            ({}, {"kind": "formula", "text": "amount * 1.2"}),
            ({}, {"kind": "multiply_amount", "category": "cut", "factor": "NaN"}),
            ({}, {"kind": "multiply_amount", "category": "cut", "factor": "1e-99999999"}),
            ({}, {"kind": "set_margin_pct", "value": 100}),
        ]:
            with self.subTest(adj=adj), self.assertRaises(ValueError):
                validate_rule(cond, adj)

    def test_embedding_synonyms(self):
        a = local_embedding("MIG welded bracket")
        self.assertEqual(a, local_embedding("GMAW welded bracket"))
        self.assertAlmostEqual(sum(n * n for n in a), 1.0)
        self.assertEqual(len(a), 1536)
        self.assertTrue(all(math.isfinite(v) for v in a))


async def postgres_checks():
    prefix = "rag-" + uuid4().hex[:8] + "-"
    os.environ["NFIP_EMBEDDING_PROVIDER"] = "local"
    async with sessions()() as db:
        customer = Customer(company_name=prefix)
        db.add(customer)
        await db.flush()

        async def drawing(key, revision, content):
            row = Drawing(drawing_key=prefix + key, revision=revision, source_type="NATIVE_DXF",
                          original_filename="fixture.dxf", content_type="application/dxf",
                          content_sha256=hashlib.sha256((prefix + content).encode()).hexdigest(),
                          source_key="fixture", source_version="1")
            db.add(row)
            await db.flush()
            return row.id

        prior = await drawing("drawing", 1, "original")
        current = await drawing("drawing", 2, "revised")
        copied = await drawing("duplicate", 1, "revised")
        default = {"material_family": "aluminum", "weight_lb": 6.0, "processes": ["CUT", "GTAW"]}

        async def quote(key, *, revision=1, count=1, entered=None, time=EARLY, drawing_id=None,
                        state="approved", description="TIG fixture flange", reason="Include fixture setup"):
            q = Quote(quote_number=prefix + key, revision=revision, created_at=time, customer_id=customer.id,
                      customer_name=customer.company_name, drawing_id=drawing_id, job_name="fixture",
                      status=state, gross_margin_pct=25, payload_sha256="0" * 64,
                      pricing_inputs={"details": {"pricingDecision": {"kind": "one_time", "reason": "first order"}}})
            db.add(q)
            await db.flush()
            for i in range(count):
                db.add(QuoteLineItem(quote_id=q.id, line_key=f"line-{i}", description=description,
                                     position=i, quantity=8, entered={"retrieval": default} if entered is None else entered,
                                     ai_proposed={"hours": 0.75}, nick_approved={"hours": 1.5},
                                     confidence_score=0.9, citations=[], basis="fixture setup", override_reason=reason))
            await db.flush()
            wrote = await index_approved_quote(db, q.id)
            assert wrote == (0 if state == "draft" else count)
            assert await index_approved_quote(db, q.id) == 0
            return q

        await quote("same", count=2)
        await quote("same", revision=2, count=2)
        await quote("superseded")
        await quote("superseded", revision=2, entered={"retrieval": {**default, "material_family": "copper"}})
        await quote("other-material", entered={"retrieval": {**default, "material_family": "316SS"}})
        await quote("heavy", entered={"retrieval": {**default, "weight_lb": 12.1}})
        await quote("unknown-weight", entered={"retrieval": {**default, "weight_lb": None}})
        await quote("other-process", entered={"retrieval": {**default, "processes": ["CUT", "GMAW"]}})
        for key, kwargs in [("self", {}), ("prior", {"drawing_id": prior}), ("copied", {"drawing_id": copied}),
                            ("future", {"time": FUTURE}), ("draft", {"state": "draft"})]:
            await quote(key, **kwargs)
        # Phase 1 purchased weight is per SHEET. Derive blank volume from mm, never use 900 lb as per-piece mass.
        await quote("legacy", entered={"routing": {"stockSource": {"material": {"spec_code": "6061-T6",
                          "density_lb_per_in3": "0.0975"}, "weightLb": 900},
                          "stock": {"blankWidth": 254, "blankHeight": 254, "thicknessMm": 12.7},
                          "operations": [{"unit": "mm cut", "name": "plasma"}, {"name": "TIG"}]}})
        for i in range(5):
            await quote("similar" + str(i), description="TIG structural mount assembly")

        async def rule(key, rev, status, adjustment, *, when=EARLY, condition=None):
            db.add(NickRule(rule_key=prefix + key, revision=rev, created_at=when, status=status,
                            approved_by="Nick" if status == "approved" else None, rule_category="SHOP",
                            condition_json=condition if condition is not None else {}, adjustment=adjustment,
                            rationale="Fixture history", citations=[]))

        base_rule = {"kind": "multiply_amount", "category": "weld", "stage": "setup", "factor": "1.2"}
        await rule("fixture", 1, "approved", base_rule, condition={"material_family": "6061", "processes": ["TIG"],
                                                                  "min_quantity": 2, "max_weight_lb": 7.5})
        await rule("fixture", 2, "proposed", {**base_rule, "factor": 3})
        await rule("fixture", 3, "retired", base_rule, when=FUTURE)
        await rule("old", 1, "approved", base_rule)
        await rule("old", 2, "retired", base_rule)
        await rule("mismatch", 1, "approved", base_rule, condition={"customer_name": "another client"})
        await rule("margin", 1, "approved", {"kind": "set_margin_pct", "value": "28"})
        await rule("bad", 1, "approved", {"kind": "eval", "formula": "raise"})
        await db.flush()
        lookup = {"description": "GTAW fixture flange", "material_family": "6061-T6", "processes": ["cut", "TIG"],
                  "weight_lb": 6, "quantity": 8, "as_of": CUTOFF, "customer_name": prefix,
                  "exclude_quote_number": prefix + "self", "exclude_drawing_id": current}
        ctx = await retrieve_context(db, **lookup)
        hits = ctx["historical_quotes"]
        keys = {h["quote_number"].removeprefix(prefix) for h in hits}
        assert len(hits) == len(keys) == 5
        assert keys <= {"legacy", "same", *("similar" + str(i) for i in range(5))}
        assert {"legacy", "same"} <= keys and hits[0]["similarity"] > hits[-1]["similarity"]
        assert next(h["revision"] for h in hits if h["quote_number"].endswith("same")) == 2
        assert next(h["weight_lb"] for h in hits if h["quote_number"].endswith("legacy")) == 4.875
        assert all(h["citation"]["reference"] == h["quote_id"] + "/" + h["line_id"] for h in hits)
        assert hits[0]["nick_approved"] != hits[0]["ai_proposed"] and hits[0]["override_reason"]
        assert hits[0]["pricing_decision"]["kind"] == "one_time" and ctx["embedding_model"] == LOCAL_MODEL
        assert [r["rule_key"] for r in ctx["rules"]] == [prefix + "fixture", prefix + "margin"]
        assert any("unsupported rule" in w for w in ctx["warnings"])
        assert not (await retrieve_context(db, **{**lookup, "weight_lb": 10000}))["historical_quotes"]
        rows = [{"category": "weld", "stage": "setup", "amount": "1.50", "rate": "60"},
                {"category": "weld", "stage": "run", "amount": "0.10", "rate": "60"}]
        result = apply_rules(cost_rows=rows, margin_pct=25, rules=ctx["rules"])
        assert Decimal(result["cost_rows"][0]["amount"]) == Decimal("1.8")
        assert result["cost_rows"][1] == rows[1] and rows[0]["amount"] == "1.50"
        assert len(result["applied_rules"]) == 2 and result["margin_pct"] == "28"
        duplicate = {**ctx["rules"][0], "id": "another", "rule_key": "also matches"}
        conflict = apply_rules(cost_rows=rows, margin_pct=25, rules=[*ctx["rules"], duplicate])
        assert conflict["cost_rows"][0] == rows[0] and conflict["warnings"]
        margin, warnings = resolve_margin(25, [ctx, {"rules": [{"adjustment": {"kind": "set_margin_pct", "value": 20}}]}])
        assert margin == "25" and warnings
        # Exercise transient provider failure and both sides of incremental cloud backfill, without external traffic.
        with patch.dict(os.environ, NFIP_EMBEDDING_PROVIDER="openai"):
            with patch("packages.ai.quote_rag._openai_embeddings", side_effect=RuntimeError("test outage")):
                offline = await retrieve_context(db, **lookup)
                assert offline["historical_quotes"] == hits and offline["warnings"][0].startswith("Hosted")
            with patch("packages.ai.quote_rag._openai_embeddings", side_effect=lambda docs: [local_embedding(d) for d in docs]):
                catching_up = await retrieve_context(db, **lookup)
                assert catching_up["embedding_model"] == LOCAL_MODEL
                caught_up = await retrieve_context(db, **lookup)
                assert caught_up["embedding_model"] == OPENAI_MODEL
                assert caught_up["historical_quotes"] == hits
        await db.rollback()
    print("PostgreSQL integration passed: cosine ranking, SQL filters, five distinct jobs, lineage, rule revisions and edits.")


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RuleTests)
    if not unittest.TextTestRunner().run(suite).wasSuccessful():
        raise SystemExit(1)
    asyncio.run(postgres_checks())
