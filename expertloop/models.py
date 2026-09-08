from __future__ import annotations

import enum
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from expertloop.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class State(enum.StrEnum):
    draft = "draft"
    in_review = "in_review"
    changes_requested = "changes_requested"
    approved = "approved"
    published = "published"
    retired = "retired"


class Source(Base):
    __tablename__ = "sources"
    __table_args__ = (UniqueConstraint("kind", "ref", name="uq_sources_kind_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))  # url | doc | ticket
    ref: Mapped[str] = mapped_column(String(512))
    title: Mapped[str | None] = mapped_column(String(256))
    content: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(256))
    author: Mapped[str] = mapped_column(String(128))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_sets: Mapped[list[InstructionSet]] = relationship(back_populates="note")


class InstructionSet(Base):
    __tablename__ = "instruction_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    note_id: Mapped[int] = mapped_column(ForeignKey("notes.id"))
    name: Mapped[str] = mapped_column(String(256))
    state: Mapped[State] = mapped_column(Enum(State, name="instruction_state"), default=State.draft)
    version: Mapped[int] = mapped_column(Integer, default=1)
    published_version: Mapped[int | None] = mapped_column(Integer)
    required_approvals: Mapped[int] = mapped_column(Integer, default=1)
    review_round: Mapped[int] = mapped_column(Integer, default=0)
    # required_roles, allow_self_approval, review_deadline_hours (see reviews.ReviewPolicy)
    review_policy: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    document: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    note: Mapped[Note] = relationship(back_populates="instruction_sets")
    versions: Mapped[list[InstructionSetVersion]] = relationship(
        back_populates="instruction_set", order_by="InstructionSetVersion.version"
    )
    edits: Mapped[list[Edit]] = relationship(back_populates="instruction_set", order_by="Edit.id")
    reviews: Mapped[list[ReviewDecision]] = relationship(
        back_populates="instruction_set", order_by="ReviewDecision.id"
    )
    audit: Mapped[list[AuditEvent]] = relationship(
        back_populates="instruction_set", order_by="AuditEvent.id"
    )
    test_cases: Mapped[list[TestCase]] = relationship(
        back_populates="instruction_set", order_by="TestCase.id"
    )
    test_runs: Mapped[list[TestRun]] = relationship(
        back_populates="instruction_set", order_by="TestRun.id"
    )
    publications: Mapped[list[Publication]] = relationship(
        back_populates="instruction_set", order_by="Publication.id"
    )
    drift_flags: Mapped[list[DriftFlag]] = relationship(
        back_populates="instruction_set", order_by="DriftFlag.id"
    )


class InstructionSetVersion(Base):
    __tablename__ = "instruction_set_versions"
    __table_args__ = (UniqueConstraint("instruction_set_id", "version", name="uq_isv_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    version: Mapped[int] = mapped_column(Integer)
    document: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="versions")


class Edit(Base):
    __tablename__ = "edits"

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    author: Mapped[str] = mapped_column(String(128))
    from_version: Mapped[int] = mapped_column(Integer)
    to_version: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text)
    diff: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="edits")


class ReviewDecision(Base):
    __tablename__ = "review_decisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    reviewer: Mapped[str] = mapped_column(String(128))
    reviewer_role: Mapped[str] = mapped_column(String(32))
    version: Mapped[int] = mapped_column(Integer)
    review_round: Mapped[int] = mapped_column(Integer)
    decision: Mapped[str] = mapped_column(String(32))  # approve | request_changes
    comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="reviews")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    actor: Mapped[str] = mapped_column(String(128))
    action: Mapped[str] = mapped_column(String(64))
    from_state: Mapped[str | None] = mapped_column(String(32))
    to_state: Mapped[str | None] = mapped_column(String(32))
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="audit")


class TestCase(Base):
    __tablename__ = "test_cases"

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    name: Mapped[str] = mapped_column(String(256))
    author: Mapped[str] = mapped_column(String(128))
    scenario: Mapped[dict[str, Any]] = mapped_column(JSONB)
    expectations: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="test_cases")


class TestRun(Base):
    __tablename__ = "test_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    version: Mapped[int] = mapped_column(Integer)
    triggered_by: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16))  # passed | failed
    passed: Mapped[int] = mapped_column(Integer)
    failed: Mapped[int] = mapped_column(Integer)
    results: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="test_runs")


class Publication(Base):
    __tablename__ = "publications"

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    version: Mapped[int] = mapped_column(Integer)
    actor: Mapped[str] = mapped_column(String(128))
    action: Mapped[str] = mapped_column(String(16))  # publish | rollback
    target: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))  # delivered | failed
    receipt: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="publications")


class DriftFlag(Base):
    """A step whose cited source hash no longer matches the registry.

    Open flags (``resolved_at`` is null) block publication. A flag is resolved when an
    expert re-verifies the step against the changed source or edits the set so the
    citation carries the current hash.
    """

    __tablename__ = "drift_flags"

    id: Mapped[int] = mapped_column(primary_key=True)
    instruction_set_id: Mapped[int] = mapped_column(ForeignKey("instruction_sets.id"))
    step_id: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"))
    cited_hash: Mapped[str] = mapped_column(String(64))
    current_hash: Mapped[str] = mapped_column(String(64))
    detected_by: Mapped[str] = mapped_column(String(128))
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[str | None] = mapped_column(String(128))
    resolution: Mapped[str | None] = mapped_column(String(16))  # reverified | edited

    instruction_set: Mapped[InstructionSet] = relationship(back_populates="drift_flags")
