"""Application service layer: every state change goes through here and is audited."""

from __future__ import annotations

import difflib
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from expertloop import drift, metrics
from expertloop.auth import Principal
from expertloop.compiler import compile_note
from expertloop.compiler.compile import citation_coverage, render_prompt, validate_document
from expertloop.executor import run_test_case
from expertloop.models import (
    AuditEvent,
    Edit,
    InstructionSet,
    InstructionSetVersion,
    Note,
    Publication,
    ReviewDecision,
    State,
    TestCase,
    TestRun,
)
from expertloop.sources import resolve_citations
from expertloop.targets.base import DeliveryError, Target
from expertloop.workflow import EDITABLE_STATES, IllegalTransition, assert_transition


class NotFound(Exception):
    pass


class Conflict(Exception):
    def __init__(self, message: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail or {}


class Invalid(Exception):
    def __init__(self, message: str, problems: list[str]) -> None:
        super().__init__(message)
        self.message = message
        self.problems = problems


def _audit(
    session: Session,
    instruction_set: InstructionSet,
    actor: Principal,
    action: str,
    from_state: State | None,
    to_state: State | None,
    **detail: Any,
) -> None:
    session.add(
        AuditEvent(
            instruction_set_id=instruction_set.id,
            actor=actor.name,
            action=action,
            from_state=from_state.value if from_state else None,
            to_state=to_state.value if to_state else None,
            detail=detail,
        )
    )


def get_instruction_set(session: Session, instruction_set_id: int) -> InstructionSet:
    instruction_set = session.get(InstructionSet, instruction_set_id)
    if instruction_set is None:
        raise NotFound(f"instruction set {instruction_set_id} not found")
    return instruction_set


def ingest_note(
    session: Session,
    actor: Principal,
    title: str,
    body: str,
    required_approvals: int,
) -> tuple[Note, InstructionSet, dict[str, Any], int]:
    note = Note(title=title, author=actor.name, body=body)
    session.add(note)
    session.flush()
    document = compile_note(body, note_id=note.id, name=title)
    linked = resolve_citations(session, document)
    problems = validate_document(document)
    if problems:
        raise Invalid("compiled document is not valid", problems)
    instruction_set = InstructionSet(
        note_id=note.id,
        name=title,
        state=State.draft,
        version=1,
        required_approvals=required_approvals,
        document=document,
    )
    session.add(instruction_set)
    session.flush()
    session.add(
        InstructionSetVersion(instruction_set_id=instruction_set.id, version=1, document=document)
    )
    coverage = citation_coverage(document)
    _audit(
        session, instruction_set, actor, "ingest", None, State.draft, note_id=note.id, **coverage
    )
    session.commit()
    return note, instruction_set, coverage, linked


def _diff(old: dict[str, Any], new: dict[str, Any]) -> str:
    before = json.dumps(old, indent=2, sort_keys=True).splitlines()
    after = json.dumps(new, indent=2, sort_keys=True).splitlines()
    return "\n".join(difflib.unified_diff(before, after, "before", "after", lineterm=""))


def _without_hashes(step: dict[str, Any]) -> tuple[Any, Any]:
    body = {k: v for k, v in step.items() if k != "citations"}
    cites = [{k: v for k, v in c.items() if k != "source_hash"} for c in step.get("citations", [])]
    return body, cites


def _keep_hashes_of_unchanged_steps(old: dict[str, Any], new: dict[str, Any]) -> None:
    """Only steps that actually changed pick up the registry's current source hashes.

    ``resolve_citations`` refreshes every citation; restoring the previous hashes on
    untouched steps keeps their drift flags open until an expert edits or re-verifies them.
    """
    previous = {step["id"]: step for step in old.get("steps", [])}
    for step in new.get("steps", []):
        before = previous.get(step.get("id"))
        if before is not None and _without_hashes(before) == _without_hashes(step):
            step["citations"] = json.loads(json.dumps(before.get("citations", [])))


def apply_edit(
    session: Session,
    actor: Principal,
    instruction_set_id: int,
    expected_version: int,
    reason: str,
    document: dict[str, Any],
) -> Edit:
    instruction_set = get_instruction_set(session, instruction_set_id)
    if instruction_set.state not in EDITABLE_STATES:
        raise IllegalTransition("edit", instruction_set.state)
    if instruction_set.version != expected_version:
        raise Conflict(
            f"version mismatch: expected {expected_version}, current is {instruction_set.version}",
            {"current_version": instruction_set.version},
        )
    document = json.loads(json.dumps(document))
    problems = validate_document(document)
    if problems:
        raise Invalid("edited document is not valid", problems)
    resolve_citations(session, document)
    _keep_hashes_of_unchanged_steps(instruction_set.document, document)
    document["agent_prompt"] = render_prompt(document)
    diff = _diff(instruction_set.document, document)
    if not diff:
        raise Conflict("edit does not change the document")

    from_state = instruction_set.state
    new_version = instruction_set.version + 1
    edit = Edit(
        instruction_set_id=instruction_set.id,
        author=actor.name,
        from_version=instruction_set.version,
        to_version=new_version,
        reason=reason,
        diff=diff,
    )
    session.add(edit)
    session.add(
        InstructionSetVersion(
            instruction_set_id=instruction_set.id, version=new_version, document=document
        )
    )
    instruction_set.document = document
    instruction_set.version = new_version
    resolved = drift.resolve_after_edit(session, actor, instruction_set)
    if from_state == State.approved:
        instruction_set.state = assert_transition("edit_after_approval", from_state)
    elif from_state == State.published:
        instruction_set.state = assert_transition("revise", from_state)
    _audit(
        session,
        instruction_set,
        actor,
        "edit",
        from_state,
        instruction_set.state,
        from_version=edit.from_version,
        to_version=new_version,
        reason=reason,
        drift_resolved=[f.step_id for f in resolved],
    )
    session.commit()
    return edit


def reverify(
    session: Session, actor: Principal, instruction_set_id: int, step_ids: list[str] | None
) -> list[Any]:
    """An expert confirms stale steps still hold against the changed source."""
    instruction_set = get_instruction_set(session, instruction_set_id)
    wanted = set(step_ids) if step_ids else None
    resolved = drift.resolve_flags(session, actor, instruction_set, wanted, "reverified")
    if not resolved:
        raise Conflict(
            "no open drift flags to verify" + (f" for {sorted(wanted)}" if wanted else "")
        )
    _audit(
        session,
        instruction_set,
        actor,
        "drift_reverified",
        instruction_set.state,
        instruction_set.state,
        steps=[f.step_id for f in resolved],
    )
    session.commit()
    return resolved


def transition(
    session: Session, actor: Principal, instruction_set_id: int, action: str
) -> InstructionSet:
    instruction_set = get_instruction_set(session, instruction_set_id)
    from_state = instruction_set.state
    instruction_set.state = assert_transition(action, from_state)
    if action in ("submit", "resubmit"):
        instruction_set.review_round += 1
    _audit(session, instruction_set, actor, action, from_state, instruction_set.state)
    session.commit()
    return instruction_set


def count_approvals(session: Session, instruction_set: InstructionSet) -> int:
    rows = session.scalars(
        select(ReviewDecision.reviewer).where(
            ReviewDecision.instruction_set_id == instruction_set.id,
            ReviewDecision.version == instruction_set.version,
            ReviewDecision.review_round == instruction_set.review_round,
            ReviewDecision.decision == "approve",
        )
    ).all()
    return len(set(rows))


def review(
    session: Session, actor: Principal, instruction_set_id: int, decision: str, comment: str
) -> tuple[InstructionSet, int]:
    instruction_set = get_instruction_set(session, instruction_set_id)
    if instruction_set.state != State.in_review:
        raise IllegalTransition(decision, instruction_set.state)
    if instruction_set.note.author == actor.name:
        raise Conflict("the author of a note cannot review their own instruction set")
    session.add(
        ReviewDecision(
            instruction_set_id=instruction_set.id,
            reviewer=actor.name,
            reviewer_role=actor.role,
            version=instruction_set.version,
            review_round=instruction_set.review_round,
            decision=decision,
            comment=comment,
        )
    )
    session.flush()
    from_state = instruction_set.state
    if decision == "request_changes":
        instruction_set.state = assert_transition("request_changes", from_state)
        _audit(
            session,
            instruction_set,
            actor,
            "request_changes",
            from_state,
            instruction_set.state,
            comment=comment,
        )
        session.commit()
        return instruction_set, 0
    approvals = count_approvals(session, instruction_set)
    if approvals >= instruction_set.required_approvals:
        instruction_set.state = assert_transition("approve", from_state)
        _audit(
            session,
            instruction_set,
            actor,
            "approve",
            from_state,
            instruction_set.state,
            approvals=approvals,
        )
    else:
        _audit(
            session,
            instruction_set,
            actor,
            "approval_recorded",
            from_state,
            from_state,
            approvals=approvals,
        )
    session.commit()
    return instruction_set, approvals


def add_test_case(
    session: Session,
    actor: Principal,
    instruction_set_id: int,
    name: str,
    scenario: dict[str, Any],
    expectations: dict[str, Any],
) -> TestCase:
    instruction_set = get_instruction_set(session, instruction_set_id)
    case = TestCase(
        instruction_set_id=instruction_set.id,
        name=name,
        author=actor.name,
        scenario=scenario,
        expectations=expectations,
    )
    session.add(case)
    _audit(session, instruction_set, actor, "test_case_added", None, None, name=name)
    session.commit()
    return case


def run_tests(session: Session, actor: Principal, instruction_set_id: int) -> TestRun:
    instruction_set = get_instruction_set(session, instruction_set_id)
    if not instruction_set.test_cases:
        raise Conflict("instruction set has no test cases")
    results = []
    for case in instruction_set.test_cases:
        outcome = run_test_case(instruction_set.document, case.scenario, case.expectations)
        results.append({"test_case_id": case.id, "name": case.name, **outcome})
    passed = sum(1 for r in results if r["passed"])
    failed = len(results) - passed
    run = TestRun(
        instruction_set_id=instruction_set.id,
        version=instruction_set.version,
        triggered_by=actor.name,
        status="passed" if failed == 0 else "failed",
        passed=passed,
        failed=failed,
        results=results,
    )
    session.add(run)
    metrics.test_runs_total.labels(status=run.status).inc()
    _audit(
        session,
        instruction_set,
        actor,
        "test_run",
        None,
        None,
        status=run.status,
        passed=passed,
        failed=failed,
    )
    session.commit()
    return run


def latest_test_run(session: Session, instruction_set: InstructionSet) -> TestRun | None:
    return session.scalars(
        select(TestRun)
        .where(TestRun.instruction_set_id == instruction_set.id)
        .order_by(TestRun.id.desc())
        .limit(1)
    ).first()


def _publish_gate(session: Session, instruction_set: InstructionSet) -> TestRun:
    if instruction_set.state != State.approved:
        raise IllegalTransition("publish", instruction_set.state)
    stale = sorted({f.step_id for f in drift.open_flags(session, instruction_set)})
    if stale:
        raise Conflict(
            "publish blocked: stale steps cite changed sources: " + ", ".join(stale),
            {"stale_steps": stale},
        )
    run = latest_test_run(session, instruction_set)
    if run is None:
        raise Conflict("publish blocked: no test run recorded for this instruction set")
    if run.version != instruction_set.version:
        raise Conflict(
            "publish blocked: latest test run covers version "
            f"{run.version}, current is {instruction_set.version}",
            {"test_run_id": run.id},
        )
    if run.status != "passed":
        failing = [r["name"] for r in run.results if not r["passed"]]
        raise Conflict(
            "publish blocked: failing test cases: " + ", ".join(failing),
            {"test_run_id": run.id, "failing_cases": failing},
        )
    return run


def _deliver(
    session: Session,
    actor: Principal,
    instruction_set: InstructionSet,
    version: int,
    document: dict[str, Any],
    action: str,
    targets: list[Target],
    extra: dict[str, Any],
) -> list[Publication]:
    payload = {
        "event": f"instruction_set.{action}",
        "action": action,
        "instruction_set_id": instruction_set.id,
        "name": instruction_set.name,
        "version": version,
        "document": document,
        **extra,
    }
    publications: list[Publication] = []
    for target in targets:
        try:
            receipt = target.deliver(payload)
            status, body = receipt.status, receipt.receipt
        except DeliveryError as exc:
            status, body = "failed", {"error": str(exc)}
        publication = Publication(
            instruction_set_id=instruction_set.id,
            version=version,
            actor=actor.name,
            action=action,
            target=target.name,
            status=status,
            receipt=body,
        )
        session.add(publication)
        publications.append(publication)
    session.flush()
    return publications


def publish(
    session: Session, actor: Principal, instruction_set_id: int, targets: list[Target]
) -> tuple[InstructionSet, list[Publication]]:
    instruction_set = get_instruction_set(session, instruction_set_id)
    try:
        run = _publish_gate(session, instruction_set)
    except (Conflict, IllegalTransition) as exc:
        metrics.publishes_total.labels(result="blocked").inc()
        _audit(
            session,
            instruction_set,
            actor,
            "publish_blocked",
            instruction_set.state,
            instruction_set.state,
            reason=str(exc),
        )
        session.commit()
        raise
    from_state = instruction_set.state
    publications = _deliver(
        session,
        actor,
        instruction_set,
        instruction_set.version,
        instruction_set.document,
        "publish",
        targets,
        {"test_run_id": run.id, "approvals": count_approvals(session, instruction_set)},
    )
    failed = [p for p in publications if p.status != "delivered"]
    if failed:
        metrics.publishes_total.labels(result="failed").inc()
        _audit(
            session,
            instruction_set,
            actor,
            "publish_failed",
            from_state,
            from_state,
            targets=[p.target for p in failed],
        )
        session.commit()
        raise Conflict(
            "publish failed: " + ", ".join(f"{p.target}: {p.receipt.get('error')}" for p in failed),
            {"targets": [p.target for p in failed]},
        )
    instruction_set.state = assert_transition("publish", from_state)
    instruction_set.published_version = instruction_set.version
    metrics.publishes_total.labels(result="delivered").inc()
    _audit(
        session,
        instruction_set,
        actor,
        "publish",
        from_state,
        instruction_set.state,
        version=instruction_set.version,
        targets=[p.target for p in publications],
    )
    session.commit()
    return instruction_set, publications


def rollback(
    session: Session, actor: Principal, instruction_set_id: int, targets: list[Target]
) -> tuple[InstructionSet, list[Publication]]:
    instruction_set = get_instruction_set(session, instruction_set_id)
    if instruction_set.published_version is None:
        raise Conflict("nothing is published for this instruction set")
    delivered_versions = sorted(
        {
            p.version
            for p in instruction_set.publications
            if p.action == "publish"
            and p.status == "delivered"
            and p.version < instruction_set.published_version
        }
    )
    if not delivered_versions:
        raise Conflict(
            "no earlier published version to roll back to "
            f"(live is v{instruction_set.published_version})"
        )
    previous = delivered_versions[-1]
    snapshot = session.scalar(
        select(InstructionSetVersion).where(
            InstructionSetVersion.instruction_set_id == instruction_set.id,
            InstructionSetVersion.version == previous,
        )
    )
    if snapshot is None:
        raise NotFound(f"version {previous} snapshot missing")
    current = instruction_set.published_version
    publications = _deliver(
        session,
        actor,
        instruction_set,
        previous,
        snapshot.document,
        "rollback",
        targets,
        {"rolled_back_from": current},
    )
    failed = [p for p in publications if p.status != "delivered"]
    if failed:
        session.commit()
        raise Conflict("rollback failed: " + ", ".join(p.target for p in failed))
    instruction_set.published_version = previous
    metrics.rollbacks_total.inc()
    _audit(
        session,
        instruction_set,
        actor,
        "rollback",
        instruction_set.state,
        instruction_set.state,
        from_version=current,
        to_version=previous,
    )
    session.commit()
    return instruction_set, publications
