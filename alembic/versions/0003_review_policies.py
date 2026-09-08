"""review policies and deadlines

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-08
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "instruction_sets",
        sa.Column("review_policy", postgresql.JSONB, nullable=False, server_default="{}"),
    )
    op.add_column("instruction_sets", sa.Column("submitted_at", sa.DateTime(timezone=True)))
    op.add_column("instruction_sets", sa.Column("review_deadline_at", sa.DateTime(timezone=True)))
    op.add_column("instruction_sets", sa.Column("escalated_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    for column in ("escalated_at", "review_deadline_at", "submitted_at", "review_policy"):
        op.drop_column("instruction_sets", column)
