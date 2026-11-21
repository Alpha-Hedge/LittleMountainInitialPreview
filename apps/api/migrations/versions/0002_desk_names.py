"""Match existing desktop record limits without changing any stored values."""
import sqlalchemy as sa
from alembic import op

revision = "0002_desk_names"
down_revision = "0001_engineering"
branch_labels = None
depends_on = None


def upgrade():
    for table, column in (("customers","company_name"),("quotes","customer_name"),("quotes","job_name")):
        op.alter_column(table, column, type_=sa.String(500))


def downgrade():
    for table, column, limit in (("customers","company_name",300),("quotes","customer_name",300),("quotes","job_name",400)):
        # PostgreSQL checks old limits; an oversized name aborts the downgrade transaction.
        op.alter_column(table, column, type_=sa.String(limit))

