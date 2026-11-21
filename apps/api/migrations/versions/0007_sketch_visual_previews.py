"""Store presentation images independently of frozen drawing releases."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007_sketch_visual_previews"
down_revision = "0006_reviewed_shop_files"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "sketch_visual_previews",
        sa.Column("revision_id", sa.Uuid(), sa.ForeignKey("sketch_revisions.id"), primary_key=True),
        sa.Column("attempt_id", sa.Uuid(), nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("model", sa.String(150)),
        sa.Column("file", JSONB()),
        sa.Column("error", sa.Text()),
        sa.CheckConstraint("state IN ('queued','rendering','ready','failed')"),
    )


def downgrade():
    op.drop_table("sketch_visual_previews")
