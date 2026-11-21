"""Create the engineering ledger. Immutable revision 0001, independent of future ORM changes."""
from alembic import op

revision = "0001_engineering"
down_revision = None
branch_labels = None
depends_on = None

HEADER = "id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),"
TABLES = {
    "work_centers": """
      name varchar(100) NOT NULL, effective_on date NOT NULL, hourly_rate numeric(14,4) NOT NULL,
      unit varchar(40) NOT NULL, includes text NOT NULL, default_setup_minutes numeric(10,3) NOT NULL,
      efficiency_factor numeric(8,4) NOT NULL, UNIQUE(name,effective_on),
      CHECK(hourly_rate >= 0 AND default_setup_minutes >= 0 AND efficiency_factor > 0)""",
    "materials": """
      spec_code varchar(80) NOT NULL, category varchar(50) NOT NULL, supplier varchar(180) NOT NULL,
      effective_on date NOT NULL, density_lb_per_in3 numeric(12,8) NOT NULL, cost_per_lb numeric(14,4) NOT NULL,
      default_scrap_pct numeric(8,4) NOT NULL, k_factor numeric(6,5), includes text NOT NULL,
      UNIQUE(spec_code,supplier,effective_on), CHECK(cost_per_lb >= 0 AND density_lb_per_in3 > 0 AND default_scrap_pct >= 0),
      CHECK(k_factor IS NULL OR k_factor BETWEEN 0 AND 1)""",
    "customers": """
      company_name varchar(300) NOT NULL UNIQUE, pricing_tier varchar(50) NOT NULL DEFAULT 'STANDARD',
      default_margin_pct numeric(7,4), payment_terms text, special_notes text,
      CHECK(default_margin_pct >= 0 AND default_margin_pct < 100)""",
    "drawings": """
      drawing_key varchar(128) NOT NULL, revision integer NOT NULL, source_type varchar(30) NOT NULL,
      original_filename varchar(255) NOT NULL, content_type varchar(100) NOT NULL,
      content_sha256 varchar(64) NOT NULL, source_key text NOT NULL, source_version text NOT NULL,
      extracted_ast jsonb, reviewed_ast jsonb, export_artifacts jsonb, needs_human_review boolean NOT NULL DEFAULT true,
      UNIQUE(drawing_key,revision), CHECK(revision > 0 AND octet_length(content_sha256)=64),
      CHECK(source_type IN ('HAND_SKETCH','CUSTOMER_PDF','CUSTOMER_IMAGE','NATIVE_DXF','NATIVE_DWG','STEP'))""",
    "quotes": """
      quote_number varchar(100) NOT NULL, revision integer NOT NULL, customer_id uuid NOT NULL REFERENCES customers(id),
      customer_name varchar(300) NOT NULL, drawing_id uuid REFERENCES drawings(id), job_name varchar(400) NOT NULL,
      status varchar(32) NOT NULL, gross_margin_pct numeric(8,5) NOT NULL, pricing_inputs jsonb NOT NULL,
      payload_sha256 varchar(64) NOT NULL, job_embedding vector(1536), UNIQUE(quote_number,revision),
      CHECK(revision > 0 AND gross_margin_pct >= 0 AND gross_margin_pct < 100),
      CHECK(status IN ('draft','awaiting_review','approved','sent','accepted','declined','expired')),
      CHECK(jsonb_typeof(pricing_inputs)='object')""",
    "quote_line_items": """
      quote_id uuid NOT NULL REFERENCES quotes(id), work_center_id uuid REFERENCES work_centers(id), position integer NOT NULL,
      line_key varchar(160) NOT NULL, description text NOT NULL, quantity integer NOT NULL,
      entered jsonb NOT NULL, ai_proposed jsonb, nick_approved jsonb, confidence_score numeric(12,10), citations jsonb NOT NULL,
      basis text NOT NULL, override_reason text NOT NULL, UNIQUE(quote_id,position), UNIQUE(quote_id,line_key),
      CHECK(quantity > 0 AND position >= 0), CHECK(confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
      CHECK(jsonb_typeof(entered)='object' AND jsonb_typeof(citations)='array'),
      CHECK(ai_proposed IS NULL OR jsonb_typeof(ai_proposed)='object'),
      CHECK(nick_approved IS NULL OR jsonb_typeof(nick_approved)='object')""",
    "nick_rules": """
      rule_key varchar(100) NOT NULL, revision integer NOT NULL, rule_category varchar(50) NOT NULL,
      condition_json jsonb NOT NULL, adjustment jsonb NOT NULL, rationale text NOT NULL, citations jsonb NOT NULL,
      status varchar(20) NOT NULL, approved_by varchar(180), rule_embedding vector(1536), UNIQUE(rule_key,revision),
      CHECK(revision > 0 AND jsonb_typeof(condition_json)='object' AND jsonb_typeof(adjustment)='object'),
      CHECK(status IN ('proposed','approved','retired') AND (status <> 'approved' OR approved_by IS NOT NULL))""",
}


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    for name, columns in TABLES.items():
        op.execute(f"CREATE TABLE {name} ({HEADER}{columns})")
    # Runtime has immutable history even if SQL is issued outside the HTTP interface.
    op.execute("""
        CREATE FUNCTION reject_frozen_change() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Frozen engineering record. Append a new revision.'; END; $$""")
    for table in ("quotes", "quote_line_items", "work_centers", "materials", "nick_rules"):
        op.execute(f"CREATE TRIGGER frozen_record BEFORE UPDATE OR DELETE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION reject_frozen_change()")


def downgrade():
    for table in reversed(TABLES):
        op.execute(f"DROP TABLE {table}")
    op.execute("DROP FUNCTION reject_frozen_change()")
    # pgvector may be shared by other schemas in this database.

