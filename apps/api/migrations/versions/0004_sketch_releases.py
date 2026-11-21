"""Link an exact original and versioned object manifest to each sketch release."""

from alembic import op

revision = "0004_sketch_releases"
down_revision = "0003_blueprint_rag"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE sketch_revisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now(),
        drawing_id uuid NOT NULL REFERENCES drawings(id),number integer NOT NULL CHECK(number>0),
        state varchar(20) NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','reading','needs_review','released','failed')),
        request_hash varchar(64) NOT NULL,review_first boolean NOT NULL,review_note text NOT NULL DEFAULT '',
        accepted jsonb NOT NULL DEFAULT '[]'::jsonb,reading jsonb,evidence jsonb,solution jsonb,files jsonb,
        error text,claimed_at timestamptz,UNIQUE(drawing_id,number))""")
    op.create_index("ix_sketch_dispatch", "sketch_revisions", ["state", "claimed_at"])
    op.execute("""CREATE TRIGGER freeze_finished_sketch BEFORE UPDATE OR DELETE ON sketch_revisions
        FOR EACH ROW WHEN (OLD.state IN ('needs_review','released')) EXECUTE FUNCTION reject_frozen_change()""")


def downgrade():
    op.drop_table("sketch_revisions")
