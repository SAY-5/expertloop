"""Prometheus metrics: instruction sets by state, test pass rate, publish counters."""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, generate_latest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from expertloop.models import InstructionSet, State, TestRun

registry = CollectorRegistry()

instruction_sets_by_state = Gauge(
    "expertloop_instruction_sets",
    "Instruction sets by approval state",
    ["state"],
    registry=registry,
)
test_pass_rate = Gauge(
    "expertloop_test_pass_rate",
    "Share of test cases that passed across all recorded test runs",
    registry=registry,
)
test_runs_total = Counter(
    "expertloop_test_runs_total", "Test runs by status", ["status"], registry=registry
)
publishes_total = Counter(
    "expertloop_publishes_total",
    "Publish attempts by result (delivered, blocked, failed)",
    ["result"],
    registry=registry,
)
rollbacks_total = Counter("expertloop_rollbacks_total", "Rollbacks performed", registry=registry)


def refresh(session: Session) -> None:
    counts = dict(
        session.execute(
            select(InstructionSet.state, func.count()).group_by(InstructionSet.state)
        ).all()
    )
    for state in State:
        instruction_sets_by_state.labels(state=state.value).set(counts.get(state, 0))
    totals = session.execute(
        select(
            func.coalesce(func.sum(TestRun.passed), 0), func.coalesce(func.sum(TestRun.failed), 0)
        )
    ).one()
    passed, failed = int(totals[0]), int(totals[1])
    test_pass_rate.set(passed / (passed + failed) if (passed + failed) else 0.0)


def render(session: Session) -> bytes:
    refresh(session)
    return generate_latest(registry)
