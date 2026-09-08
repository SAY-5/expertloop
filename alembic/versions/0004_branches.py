"""branches of instruction sets

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-08
"""

import sqlalchemy as sa

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "instruction_sets",
        sa.Column("parent_id", sa.Integer, sa.ForeignKey("instruction_sets.id")),
    )
    op.add_column("instruction_sets", sa.Column("branched_from_version", sa.Integer))
    op.add_column("instruction_sets", sa.Column("merged_at", sa.DateTime(timezone=True)))
    op.add_column("instruction_sets", sa.Column("merged_into_version", sa.Integer))
    op.create_index("ix_instruction_sets_parent_id", "instruction_sets", ["parent_id"])


def downgrade() -> None:
    op.drop_index("ix_instruction_sets_parent_id", table_name="instruction_sets")
    for column in ("merged_into_version", "merged_at", "branched_from_version", "parent_id"):
        op.drop_column("instruction_sets", column)
