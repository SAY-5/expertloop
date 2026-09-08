"""drift flags and source check timestamps

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-08
"""

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sources", sa.Column("last_checked_at", sa.DateTime(timezone=True)))
    op.create_table(
        "drift_flags",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("step_id", sa.String(32), nullable=False),
        sa.Column("source_id", sa.Integer, sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("cited_hash", sa.String(64), nullable=False),
        sa.Column("current_hash", sa.String(64), nullable=False),
        sa.Column("detected_by", sa.String(128), nullable=False),
        sa.Column(
            "detected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("resolved_by", sa.String(128)),
        sa.Column("resolution", sa.String(16)),
    )
    op.create_index("ix_drift_flags_instruction_set_id", "drift_flags", ["instruction_set_id"])
    op.create_index("ix_drift_flags_source_id", "drift_flags", ["source_id"])


def downgrade() -> None:
    op.drop_table("drift_flags")
    op.drop_column("sources", "last_checked_at")
