"""Versioned engineering records for one shop deployment (PostgreSQL 16)."""
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column as col


class Base(DeclarativeBase):
    pass


class Record:
    id: Mapped[UUID] = col(primary_key=True, server_default=sa.text("gen_random_uuid()"))
    created_at: Mapped[datetime] = col(sa.DateTime(timezone=True), server_default=sa.func.now())


class WorkCenter(Record, Base):
    __tablename__ = "work_centers"
    __table_args__ = (
        sa.UniqueConstraint("name", "effective_on"),
        sa.CheckConstraint("hourly_rate >= 0 AND default_setup_minutes >= 0 AND efficiency_factor > 0"),
    )
    name: Mapped[str] = col(sa.String(100))
    effective_on: Mapped[date]
    hourly_rate: Mapped[Decimal] = col(sa.Numeric(14, 4))
    unit: Mapped[str] = col(sa.String(40))
    includes: Mapped[str] = col(sa.Text)
    default_setup_minutes: Mapped[Decimal] = col(sa.Numeric(10, 3))
    efficiency_factor: Mapped[Decimal] = col(sa.Numeric(8, 4))


class Material(Record, Base):
    __tablename__ = "materials"
    __table_args__ = (
        sa.UniqueConstraint("spec_code", "supplier", "effective_on"),
        sa.CheckConstraint("cost_per_lb >= 0 AND density_lb_per_in3 > 0 AND default_scrap_pct >= 0"),
        sa.CheckConstraint("k_factor IS NULL OR k_factor BETWEEN 0 AND 1"),
    )
    spec_code: Mapped[str] = col(sa.String(80))
    category: Mapped[str] = col(sa.String(50))
    supplier: Mapped[str] = col(sa.String(180))
    effective_on: Mapped[date]
    density_lb_per_in3: Mapped[Decimal] = col(sa.Numeric(12, 8))
    cost_per_lb: Mapped[Decimal] = col(sa.Numeric(14, 4))
    default_scrap_pct: Mapped[Decimal] = col(sa.Numeric(8, 4))
    k_factor: Mapped[Decimal | None] = col(sa.Numeric(6, 5))
    includes: Mapped[str] = col(sa.Text)


class Customer(Record, Base):
    __tablename__ = "customers"
    __table_args__ = (sa.CheckConstraint("default_margin_pct >= 0 AND default_margin_pct < 100"),)
    company_name: Mapped[str] = col(sa.String(500), unique=True)
    pricing_tier: Mapped[str] = col(sa.String(50), server_default="STANDARD")
    default_margin_pct: Mapped[Decimal | None] = col(sa.Numeric(7, 4))
    payment_terms: Mapped[str | None] = col(sa.Text)
    special_notes: Mapped[str | None] = col(sa.Text)


class Drawing(Record, Base):
    __tablename__ = "drawings"
    __table_args__ = (
        sa.UniqueConstraint("drawing_key", "revision"),
        sa.CheckConstraint("revision > 0 AND octet_length(content_sha256) = 64"),
        sa.CheckConstraint("source_type IN ('HAND_SKETCH','CUSTOMER_PDF','CUSTOMER_IMAGE','NATIVE_DXF','NATIVE_DWG','STEP')"),
    )
    drawing_key: Mapped[str] = col(sa.String(128))
    revision: Mapped[int]
    source_type: Mapped[str] = col(sa.String(30))
    original_filename: Mapped[str] = col(sa.String(255))
    content_type: Mapped[str] = col(sa.String(100))
    content_sha256: Mapped[str] = col(sa.String(64))
    source_key: Mapped[str] = col(sa.Text)
    source_version: Mapped[str] = col(sa.Text)
    extracted_ast: Mapped[dict | None] = col(JSONB(none_as_null=True))
    reviewed_ast: Mapped[dict | None] = col(JSONB(none_as_null=True))
    export_artifacts: Mapped[dict | None] = col(JSONB(none_as_null=True))
    needs_human_review: Mapped[bool] = col(server_default=sa.true())


class Quote(Record, Base):
    __tablename__ = "quotes"
    __table_args__ = (
        sa.UniqueConstraint("quote_number", "revision"),
        sa.CheckConstraint("revision > 0 AND gross_margin_pct >= 0 AND gross_margin_pct < 100"),
        sa.CheckConstraint("status IN ('draft','awaiting_review','approved','sent','accepted','declined','expired')"),
        sa.CheckConstraint("jsonb_typeof(pricing_inputs) = 'object'"),
    )
    quote_number: Mapped[str] = col(sa.String(100))
    revision: Mapped[int]
    customer_id: Mapped[UUID] = col(sa.ForeignKey("customers.id"))
    customer_name: Mapped[str] = col(sa.String(500))
    drawing_id: Mapped[UUID | None] = col(sa.ForeignKey("drawings.id"))
    job_name: Mapped[str] = col(sa.String(500))
    status: Mapped[str] = col(sa.String(32))
    gross_margin_pct: Mapped[Decimal] = col(sa.Numeric(8, 5))
    pricing_inputs: Mapped[dict] = col(JSONB)
    payload_sha256: Mapped[str] = col(sa.String(64))
    job_embedding: Mapped[list[float] | None] = col(Vector(1536))


class QuoteLineItem(Record, Base):
    __tablename__ = "quote_line_items"
    __table_args__ = (
        sa.UniqueConstraint("quote_id", "position"),
        sa.UniqueConstraint("quote_id", "line_key"),
        sa.CheckConstraint("quantity > 0 AND position >= 0"),
        sa.CheckConstraint("confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1"),
        sa.CheckConstraint("jsonb_typeof(entered) = 'object' AND jsonb_typeof(citations) = 'array'"),
        sa.CheckConstraint("ai_proposed IS NULL OR jsonb_typeof(ai_proposed) = 'object'"),
        sa.CheckConstraint("nick_approved IS NULL OR jsonb_typeof(nick_approved) = 'object'"),
    )
    quote_id: Mapped[UUID] = col(sa.ForeignKey("quotes.id"))
    work_center_id: Mapped[UUID | None] = col(sa.ForeignKey("work_centers.id"))
    position: Mapped[int]
    line_key: Mapped[str] = col(sa.String(160))
    description: Mapped[str] = col(sa.Text)
    quantity: Mapped[int]
    entered: Mapped[dict] = col(JSONB)
    ai_proposed: Mapped[dict | None] = col(JSONB(none_as_null=True))
    nick_approved: Mapped[dict | None] = col(JSONB(none_as_null=True))
    confidence_score: Mapped[Decimal | None] = col(sa.Numeric(12, 10))
    citations: Mapped[list[dict]] = col(JSONB)
    basis: Mapped[str] = col(sa.Text)
    override_reason: Mapped[str] = col(sa.Text)


class NickRule(Record, Base):
    __tablename__ = "nick_rules"
    __table_args__ = (
        sa.UniqueConstraint("rule_key", "revision"),
        sa.CheckConstraint("revision > 0 AND jsonb_typeof(condition_json) = 'object' AND jsonb_typeof(adjustment) = 'object'"),
        sa.CheckConstraint("status IN ('proposed','approved','retired') AND (status <> 'approved' OR approved_by IS NOT NULL)"),
    )
    rule_key: Mapped[str] = col(sa.String(100))
    revision: Mapped[int]
    rule_category: Mapped[str] = col(sa.String(50))
    condition_json: Mapped[dict] = col(JSONB)
    adjustment: Mapped[dict] = col(JSONB)
    rationale: Mapped[str] = col(sa.Text)
    citations: Mapped[list[dict]] = col(JSONB)
    status: Mapped[str] = col(sa.String(20))
    approved_by: Mapped[str | None] = col(sa.String(180))
    rule_embedding: Mapped[list[float] | None] = col(Vector(1536))


class QuoteSearchLine(Record, Base):
    """An immutable derived fingerprint; model upgrades append a different namespace."""
    __tablename__ = "quote_search_lines"
    __table_args__ = (
        sa.UniqueConstraint("line_id", "embedding_model"),
        sa.CheckConstraint("weight_lb IS NULL OR weight_lb > 0"),
        sa.Index("ix_quote_search_material_weight", "embedding_model", "material_family", "weight_lb"),
        sa.Index("ix_quote_search_processes", "processes", postgresql_using="gin"),
        sa.Index("ix_quote_search_quote", "quote_id"),
    )
    quote_id: Mapped[UUID] = col(sa.ForeignKey("quotes.id"))
    line_id: Mapped[UUID] = col(sa.ForeignKey("quote_line_items.id"))
    material_family: Mapped[str | None] = col(sa.Text)
    weight_lb: Mapped[float | None] = col(sa.Double)
    processes: Mapped[list[str]] = col(ARRAY(sa.Text))
    embedding_model: Mapped[str] = col(sa.String(100))
    embedding: Mapped[list[float]] = col(Vector(1536))


class BlueprintQuoteJob(Record, Base):
    __tablename__ = "blueprint_quote_jobs"
    __table_args__ = (
        sa.CheckConstraint("state IN ('queued','extracting','review_required','costing','ready','failed')"),
        sa.CheckConstraint("version >= 1"),
        sa.CheckConstraint("jsonb_typeof(inputs) = 'object' AND jsonb_typeof(review_log) = 'array'"),
        sa.Index("ix_blueprint_jobs_drawing", "drawing_id"),
    )
    drawing_id: Mapped[UUID] = col(sa.ForeignKey("drawings.id"))
    request_key: Mapped[str] = col(sa.String(160), unique=True)
    request_hash: Mapped[str] = col(sa.Text)
    state: Mapped[str] = col(sa.String(32), server_default="queued")
    version: Mapped[int] = col(server_default=sa.text("1"))
    inputs: Mapped[dict] = col(JSONB)
    extraction: Mapped[dict | None] = col(JSONB(none_as_null=True))
    reviewed_ast: Mapped[dict | None] = col(JSONB(none_as_null=True))
    review_log: Mapped[list] = col(JSONB, server_default=sa.text("'[]'::jsonb"))
    result: Mapped[dict | None] = col(JSONB(none_as_null=True))
    error: Mapped[str | None] = col(sa.Text)
    updated_at: Mapped[datetime] = col(sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now())
    claimed_at: Mapped[datetime | None] = col(sa.DateTime(timezone=True))


class SketchVisualPreview(Base):
    __tablename__ = "sketch_visual_previews"
    __table_args__ = (sa.CheckConstraint("state IN ('queued','rendering','ready','failed')"),)

    revision_id: Mapped[UUID] = col(sa.ForeignKey("sketch_revisions.id"), primary_key=True)
    attempt_id: Mapped[UUID]
    state: Mapped[str] = col(sa.String(20))
    started_at: Mapped[datetime] = col(sa.DateTime(timezone=True))
    model: Mapped[str | None] = col(sa.String(150))
    file: Mapped[dict | None] = col(JSONB())
    error: Mapped[str | None] = col(sa.Text())


class SketchRevision(Record, Base):
    __tablename__ = "sketch_revisions"
    __table_args__ = (
        sa.UniqueConstraint("drawing_id","number"),
        sa.CheckConstraint("number > 0"),
        sa.CheckConstraint("state IN ('queued','reading','needs_review','released','failed')"),
        sa.Index("ix_sketch_dispatch","state","claimed_at"),
    )
    drawing_id: Mapped[UUID] = col(sa.ForeignKey("drawings.id"))
    number: Mapped[int]
    state: Mapped[str] = col(sa.String(20),server_default="queued")
    request_hash: Mapped[str] = col(sa.String(64))
    review_first: Mapped[bool]
    review_note: Mapped[str] = col(sa.Text,server_default="")
    accepted: Mapped[list] = col(JSONB,server_default=sa.text("'[]'::jsonb"))
    reading: Mapped[dict | None] = col(JSONB(none_as_null=True))
    evidence: Mapped[dict | None] = col(JSONB(none_as_null=True))
    solution: Mapped[dict | None] = col(JSONB(none_as_null=True))
    files: Mapped[dict | None] = col(JSONB(none_as_null=True))
    error: Mapped[str | None] = col(sa.Text)
    claimed_at: Mapped[datetime | None] = col(sa.DateTime(timezone=True))

