"""Freeze the audited output files of a reviewed blueprint revision."""

from alembic import op

revision = "0006_reviewed_shop_files"
down_revision = "0005_preference_distillation"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE blueprint_shop_files (
        job_id uuid NOT NULL REFERENCES blueprint_quote_jobs(id), revision integer NOT NULL CHECK(revision>0),
        manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array'), PRIMARY KEY(job_id,revision))""")


def downgrade():
    op.drop_table("blueprint_shop_files")
