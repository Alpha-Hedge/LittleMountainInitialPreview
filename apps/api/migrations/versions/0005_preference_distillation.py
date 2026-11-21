"""Durable finalization queue and per-operation evidence for estimating preferences."""

from alembic import op

revision = "0005_preference_distillation"
down_revision = "0004_sketch_releases"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE preference_jobs (
        quote_id uuid PRIMARY KEY REFERENCES quotes(id), claimed_at timestamptz, completed_at timestamptz)""")
    op.execute(
        "CREATE INDEX ix_preference_pending ON preference_jobs(claimed_at) WHERE completed_at IS NULL"
    )
    op.execute("""CREATE TABLE preference_samples (
        quote_id uuid NOT NULL REFERENCES quotes(id), line_id uuid NOT NULL REFERENCES quote_line_items(id),
        operation text NOT NULL, pattern text NOT NULL, condition_json jsonb NOT NULL,
        category text NOT NULL, stage text NOT NULL, center text NOT NULL, measure text NOT NULL,
        ai_hours numeric, nick_hours numeric, ai_cost numeric, nick_cost numeric, factor numeric NOT NULL,
        reason text NOT NULL, PRIMARY KEY (line_id, operation, measure))""")
    op.execute(
        "CREATE INDEX ix_preference_samples_pattern ON preference_samples(pattern)"
    )
    op.execute("INSERT INTO preference_jobs(quote_id) SELECT id FROM quotes")


def downgrade():
    op.drop_table("preference_samples")
    op.drop_table("preference_jobs")
