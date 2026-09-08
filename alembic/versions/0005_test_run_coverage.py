"""coverage on test runs

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-08
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "test_runs",
        sa.Column("coverage", postgresql.JSONB, nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("test_runs", "coverage")
