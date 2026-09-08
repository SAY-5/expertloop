from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from expertloop.auth import Principal, require_role
from expertloop.db import get_session
from expertloop.executor import registry
from expertloop.models import (
    AuditEvent,
    DriftFlag,
    InstructionSet,
    Publication,
    State,
    TestRun,
    utcnow,
)

router = APIRouter(prefix="/ops", tags=["ops"])


def _latest_runs(session: Session) -> list[TestRun]:
    latest_ids = select(func.max(TestRun.id)).group_by(TestRun.instruction_set_id).scalar_subquery()
    return list(session.scalars(select(TestRun).where(TestRun.id.in_(latest_ids))).all())


@router.get("/plugins")
def plugins(_: Principal = Depends(require_role("expert", "reviewer"))) -> dict[str, Any]:
    return {"condition_plugins": registry.names()}


@router.get("/overview")
def overview(
    session: Session = Depends(get_session),
    _: Principal = Depends(require_role("expert", "reviewer")),
) -> dict[str, Any]:
    """Sets by state, coverage of the latest runs, drift, reviews and publish statistics."""
    now = utcnow()
    counts = dict(
        session.execute(
            select(InstructionSet.state, func.count()).group_by(InstructionSet.state)
        ).all()
    )
    sets = list(session.scalars(select(InstructionSet)).all())
    runs = _latest_runs(session)
    with_coverage = [r for r in runs if r.coverage]
    current = [r for r in runs if r.version == r.instruction_set.version]
    open_flags = list(session.scalars(select(DriftFlag).where(DriftFlag.resolved_at.is_(None))))
    in_review = [s for s in sets if s.state == State.in_review]
    publish_results = dict(
        session.execute(
            select(Publication.status, func.count())
            .where(Publication.action == "publish")
            .group_by(Publication.status)
        ).all()
    )
    blocked = session.scalar(select(func.count()).where(AuditEvent.action == "publish_blocked"))
    rollbacks = session.scalar(select(func.count()).where(AuditEvent.action == "rollback"))

    def average(values: list[float]) -> float | None:
        return round(sum(values) / len(values), 3) if values else None

    return {
        "generated_at": now,
        "instruction_sets": {
            "total": len(sets),
            "branches": sum(1 for s in sets if s.parent_id is not None),
            "by_state": {state.value: counts.get(state, 0) for state in State},
        },
        "coverage": {
            "sets_with_runs": len(runs),
            "runs_on_current_version": len(current),
            "average_step_coverage": average([r.coverage["steps"] for r in with_coverage]),
            "average_rule_coverage": average([r.coverage["decision_rules"] for r in with_coverage]),
            "lowest": sorted(
                (
                    {
                        "instruction_set_id": r.instruction_set_id,
                        "version": r.version,
                        "steps": r.coverage["steps"],
                        "decision_rules": r.coverage["decision_rules"],
                        "uncovered_steps": r.coverage["steps_uncovered"],
                    }
                    for r in with_coverage
                ),
                key=lambda c: (c["steps"], c["decision_rules"]),
            )[:5],
        },
        "drift": {
            "open_flags": len(open_flags),
            "stale_sets": sorted({f.instruction_set_id for f in open_flags}),
        },
        "reviews": {
            "in_review": len(in_review),
            "overdue": sum(
                1
                for s in in_review
                if s.review_deadline_at is not None and s.review_deadline_at <= now
            ),
            "escalated": sum(1 for s in in_review if s.escalated_at is not None),
        },
        "publish": {
            "delivered": publish_results.get("delivered", 0),
            "failed": publish_results.get("failed", 0),
            "blocked": blocked or 0,
            "rollbacks": rollbacks or 0,
            "published_sets": sum(1 for s in sets if s.published_version is not None),
        },
        "executor_plugins": registry.names(),
    }
