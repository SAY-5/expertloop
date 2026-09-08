"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-09-08
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATES = ("draft", "in_review", "changes_requested", "approved", "published", "retired")


def _ts(name: str = "created_at") -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def upgrade() -> None:
    state_enum = postgresql.ENUM(*STATES, name="instruction_state", create_type=False)
    state_enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "sources",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("ref", sa.String(512), nullable=False),
        sa.Column("title", sa.String(256)),
        sa.Column("content", sa.Text),
        sa.Column("content_hash", sa.String(64), nullable=False),
        _ts(),
        sa.UniqueConstraint("kind", "ref", name="uq_sources_kind_ref"),
    )
    op.create_table(
        "notes",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("author", sa.String(128), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        _ts(),
    )
    op.create_table(
        "instruction_sets",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("note_id", sa.Integer, sa.ForeignKey("notes.id"), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("state", state_enum, nullable=False, server_default="draft"),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("published_version", sa.Integer),
        sa.Column("required_approvals", sa.Integer, nullable=False, server_default="1"),
        sa.Column("review_round", sa.Integer, nullable=False, server_default="0"),
        sa.Column("document", postgresql.JSONB, nullable=False),
        _ts(),
        _ts("updated_at"),
    )
    op.create_index("ix_instruction_sets_state", "instruction_sets", ["state"])
    op.create_table(
        "instruction_set_versions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("document", postgresql.JSONB, nullable=False),
        _ts(),
        sa.UniqueConstraint("instruction_set_id", "version", name="uq_isv_version"),
    )
    op.create_table(
        "edits",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("author", sa.String(128), nullable=False),
        sa.Column("from_version", sa.Integer, nullable=False),
        sa.Column("to_version", sa.Integer, nullable=False),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("diff", sa.Text, nullable=False),
        _ts(),
    )
    op.create_index("ix_edits_instruction_set_id", "edits", ["instruction_set_id"])
    op.create_table(
        "review_decisions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("reviewer", sa.String(128), nullable=False),
        sa.Column("reviewer_role", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("review_round", sa.Integer, nullable=False),
        sa.Column("decision", sa.String(32), nullable=False),
        sa.Column("comment", sa.Text, nullable=False, server_default=""),
        _ts(),
    )
    op.create_index(
        "ix_review_decisions_set_version", "review_decisions", ["instruction_set_id", "version"]
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("actor", sa.String(128), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("from_state", sa.String(32)),
        sa.Column("to_state", sa.String(32)),
        sa.Column("detail", postgresql.JSONB, nullable=False, server_default="{}"),
        _ts(),
    )
    op.create_index("ix_audit_events_instruction_set_id", "audit_events", ["instruction_set_id"])
    op.create_table(
        "test_cases",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("author", sa.String(128), nullable=False),
        sa.Column("scenario", postgresql.JSONB, nullable=False),
        sa.Column("expectations", postgresql.JSONB, nullable=False),
        _ts(),
    )
    op.create_table(
        "test_runs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("triggered_by", sa.String(128), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("passed", sa.Integer, nullable=False),
        sa.Column("failed", sa.Integer, nullable=False),
        sa.Column("results", postgresql.JSONB, nullable=False),
        _ts(),
    )
    op.create_index("ix_test_runs_instruction_set_id", "test_runs", ["instruction_set_id"])
    op.create_table(
        "publications",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "instruction_set_id", sa.Integer, sa.ForeignKey("instruction_sets.id"), nullable=False
        ),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("actor", sa.String(128), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("target", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("receipt", postgresql.JSONB, nullable=False, server_default="{}"),
        _ts(),
    )
    op.create_index("ix_publications_instruction_set_id", "publications", ["instruction_set_id"])


def downgrade() -> None:
    for table in (
        "publications",
        "test_runs",
        "test_cases",
        "audit_events",
        "review_decisions",
        "edits",
        "instruction_set_versions",
        "instruction_sets",
        "notes",
        "sources",
    ):
        op.drop_table(table)
    postgresql.ENUM(name="instruction_state").drop(op.get_bind(), checkfirst=True)
