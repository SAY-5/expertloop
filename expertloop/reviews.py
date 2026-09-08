"""Review policies, deadlines and reviewer workload.

A policy lives on the instruction set as JSON (``review_policy``): which reviewer roles
must be among the approvers, whether the author of the current version may approve it,
and how many hours a review may take before it is escalated. ``required_approvals``
stays a column of its own because the first release already exposed it.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from expertloop.auth import Principal
from expertloop.models import AuditEvent, Edit, InstructionSet, ReviewDecision, State, utcnow

REVIEW_ROLES = ("reviewer", "admin")


class ReviewPolicy(BaseModel):
    required_roles: list[str] = Field(default_factory=list)
    allow_self_approval: bool = False
    review_deadline_hours: float | None = Field(default=None, ge=0)

    @classmethod
    def of(cls, instruction_set: InstructionSet) -> ReviewPolicy:
        return cls.model_validate(instruction_set.review_policy or {})


def version_author(session: Session, instruction_set: InstructionSet) -> str:
    """Whoever produced the current version: the note author for v1, else the last editor."""
    if instruction_set.version == 1:
        return instruction_set.note.author
    author = session.scalar(
        select(Edit.author).where(
            Edit.instruction_set_id == instruction_set.id,
            Edit.to_version == instruction_set.version,
        )
    )
    return author or instruction_set.note.author


def is_self_approval(session: Session, instruction_set: InstructionSet, actor: Principal) -> bool:
    if ReviewPolicy.of(instruction_set).allow_self_approval:
        return False
    return actor.name in (instruction_set.note.author, version_author(session, instruction_set))


def approvals_this_round(session: Session, instruction_set: InstructionSet) -> list[ReviewDecision]:
    return list(
        session.scalars(
            select(ReviewDecision).where(
                ReviewDecision.instruction_set_id == instruction_set.id,
                ReviewDecision.version == instruction_set.version,
                ReviewDecision.review_round == instruction_set.review_round,
                ReviewDecision.decision == "approve",
            )
        ).all()
    )


def missing_roles(instruction_set: InstructionSet, approvals: list[ReviewDecision]) -> list[str]:
    present = {a.reviewer_role for a in approvals}
    return [r for r in ReviewPolicy.of(instruction_set).required_roles if r not in present]


def policy_satisfied(
    instruction_set: InstructionSet, approvals: list[ReviewDecision]
) -> tuple[int, list[str]]:
    """Return (distinct approvals, roles still missing)."""
    return len({a.reviewer for a in approvals}), missing_roles(instruction_set, approvals)


def start_review_clock(instruction_set: InstructionSet, now: datetime | None = None) -> None:
    now = now or utcnow()
    hours = ReviewPolicy.of(instruction_set).review_deadline_hours
    instruction_set.submitted_at = now
    instruction_set.review_deadline_at = now + timedelta(hours=hours) if hours is not None else None
    instruction_set.escalated_at = None


def is_overdue(instruction_set: InstructionSet, now: datetime | None = None) -> bool:
    now = now or utcnow()
    return (
        instruction_set.state == State.in_review
        and instruction_set.review_deadline_at is not None
        and instruction_set.review_deadline_at <= now
    )


def escalate_overdue(
    session: Session, actor: Principal, now: datetime | None = None
) -> list[InstructionSet]:
    """Write a ``review_escalated`` event for every overdue set not escalated yet."""
    now = now or utcnow()
    escalated: list[InstructionSet] = []
    for instruction_set in session.scalars(
        select(InstructionSet)
        .where(
            InstructionSet.state == State.in_review,
            InstructionSet.review_deadline_at.is_not(None),
            InstructionSet.review_deadline_at <= now,
            InstructionSet.escalated_at.is_(None),
        )
        .order_by(InstructionSet.id)
    ).all():
        instruction_set.escalated_at = now
        approvals = approvals_this_round(session, instruction_set)
        count, missing = policy_satisfied(instruction_set, approvals)
        session.add(
            AuditEvent(
                instruction_set_id=instruction_set.id,
                actor=actor.name,
                action="review_escalated",
                from_state=State.in_review.value,
                to_state=State.in_review.value,
                detail={
                    "deadline": instruction_set.review_deadline_at.isoformat(),
                    "overdue_seconds": int(
                        (now - instruction_set.review_deadline_at).total_seconds()
                    ),
                    "approvals": count,
                    "required_approvals": instruction_set.required_approvals,
                    "missing_roles": missing,
                    "review_round": instruction_set.review_round,
                },
            )
        )
        escalated.append(instruction_set)
    session.commit()
    return escalated


def workload(
    session: Session, reviewers: list[tuple[str, str]], now: datetime | None = None
) -> dict[str, Any]:
    """Queue of sets in review and, per reviewer, what still waits on them."""
    now = now or utcnow()
    queue: list[dict[str, Any]] = []
    pending_by_reviewer: dict[str, list[int]] = {name: [] for name, _ in reviewers}
    overdue_by_reviewer: dict[str, int] = {name: 0 for name, _ in reviewers}
    decided_by_reviewer = {
        name: count
        for name, count in session.execute(
            select(ReviewDecision.reviewer, func.count()).group_by(ReviewDecision.reviewer)
        ).all()
    }
    for instruction_set in session.scalars(
        select(InstructionSet)
        .where(InstructionSet.state == State.in_review)
        .order_by(InstructionSet.review_deadline_at.nulls_last(), InstructionSet.id)
    ).all():
        decided = {
            d.reviewer
            for d in session.scalars(
                select(ReviewDecision).where(
                    ReviewDecision.instruction_set_id == instruction_set.id,
                    ReviewDecision.version == instruction_set.version,
                    ReviewDecision.review_round == instruction_set.review_round,
                )
            ).all()
        }
        count, missing = policy_satisfied(
            instruction_set, approvals_this_round(session, instruction_set)
        )
        overdue = is_overdue(instruction_set, now)
        author = version_author(session, instruction_set)
        policy = ReviewPolicy.of(instruction_set)
        queue.append(
            {
                "instruction_set_id": instruction_set.id,
                "name": instruction_set.name,
                "version": instruction_set.version,
                "review_round": instruction_set.review_round,
                "submitted_at": instruction_set.submitted_at,
                "review_deadline_at": instruction_set.review_deadline_at,
                "overdue": overdue,
                "escalated": instruction_set.escalated_at is not None,
                "approvals": count,
                "required_approvals": instruction_set.required_approvals,
                "missing_roles": missing,
                "waiting_on": sorted(
                    name
                    for name, role in reviewers
                    if name not in decided
                    and (
                        policy.allow_self_approval
                        or name not in (author, instruction_set.note.author)
                    )
                    and (
                        not missing or role in missing or count < instruction_set.required_approvals
                    )
                ),
            }
        )
        for name in queue[-1]["waiting_on"]:
            pending_by_reviewer[name].append(instruction_set.id)
            if overdue:
                overdue_by_reviewer[name] += 1
    return {
        "generated_at": now,
        "queue": queue,
        "reviewers": [
            {
                "name": name,
                "role": role,
                "pending": pending_by_reviewer[name],
                "overdue": overdue_by_reviewer[name],
                "decided": decided_by_reviewer.get(name, 0),
            }
            for name, role in reviewers
        ],
    }
