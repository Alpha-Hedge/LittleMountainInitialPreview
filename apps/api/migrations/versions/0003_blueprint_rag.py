"""Add retryable generation jobs and search fingerprints without changing frozen quotes."""
from alembic import op

revision = "0003_blueprint_rag"
down_revision = "0002_desk_names"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        CREATE TABLE quote_search_lines (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            created_at timestamptz NOT NULL DEFAULT now(),
            quote_id uuid NOT NULL REFERENCES quotes(id),
            line_id uuid NOT NULL REFERENCES quote_line_items(id),
            material_family text, weight_lb double precision CHECK(weight_lb > 0 AND weight_lb < 'Infinity'),
            processes text[] NOT NULL, embedding_model varchar(100) NOT NULL, embedding vector(1536) NOT NULL,
            UNIQUE(line_id, embedding_model)
        )""")
    op.execute("CREATE INDEX ix_quote_search_quote ON quote_search_lines(quote_id)")
    op.execute("CREATE INDEX ix_quote_search_material_weight ON quote_search_lines(embedding_model,material_family,weight_lb)")
    op.execute("CREATE INDEX ix_quote_search_processes ON quote_search_lines USING gin(processes)")
    op.execute("""CREATE TRIGGER frozen_record BEFORE UPDATE OR DELETE ON quote_search_lines
                  FOR EACH ROW EXECUTE FUNCTION reject_frozen_change()""")
    op.execute("""
        CREATE TABLE blueprint_quote_jobs (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
            drawing_id uuid NOT NULL REFERENCES drawings(id), request_key varchar(160) NOT NULL UNIQUE,
            request_hash text NOT NULL, state varchar(32) NOT NULL DEFAULT 'queued'
                CHECK(state IN ('queued','extracting','review_required','costing','ready','failed')),
            version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
            inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs) = 'object'), extraction jsonb, reviewed_ast jsonb,
            review_log jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(review_log) = 'array'),
            result jsonb, error text, updated_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz
        )""")
    op.execute("CREATE INDEX ix_blueprint_jobs_drawing ON blueprint_quote_jobs(drawing_id)")


def downgrade():
    op.drop_table("blueprint_quote_jobs")
    op.drop_table("quote_search_lines")
