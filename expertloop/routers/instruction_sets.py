from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from expertloop import drift, service
from expertloop.auth import Principal, require_role
from expertloop.compiler.compile import citation_coverage
from expertloop.db import get_session
from expertloop.models import InstructionSet, InstructionSetVersion
from expertloop.schemas import (
    AuditOut,
    BranchIn,
    DriftFlagOut,
    DriftOut,
    EditIn,
    EditOut,
    InstructionSetOut,
    InstructionSetSummary,
    MergeIn,
    MergeOut,
    PolicyIn,
    PublicationOut,
    PublishOut,
    ReviewIn,
    ReviewOut,
    TestCaseIn,
    TestCaseOut,
    TestRunOut,
    TransitionOut,
    VerifyIn,
)
from expertloop.sources import verify_citations

router = APIRouter(prefix="/instruction-sets", tags=["instruction-sets"])

read_roles = require_role("expert", "reviewer")


@router.get("", response_model=list[InstructionSetSummary])
def list_instruction_sets(
    session: Session = Depends(get_session), _: Principal = Depends(read_roles)
) -> list[InstructionSet]:
    return list(session.scalars(select(InstructionSet).order_by(InstructionSet.id)).all())


@router.get("/{instruction_set_id}", response_model=InstructionSetOut)
def get_instruction_set(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> InstructionSet:
    return service.get_instruction_set(session, instruction_set_id)


@router.get("/{instruction_set_id}/prompt", response_class=PlainTextResponse)
def get_prompt(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> str:
    return service.get_instruction_set(session, instruction_set_id).document["agent_prompt"]


@router.get("/{instruction_set_id}/citations")
def get_citations(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> dict[str, Any]:
    instruction_set = service.get_instruction_set(session, instruction_set_id)
    report = verify_citations(session, instruction_set.document)
    return {
        "coverage": citation_coverage(instruction_set.document),
        "verified": sum(1 for r in report if r["verified"]),
        "unverified": sum(1 for r in report if not r["verified"]),
        "citations": report,
    }


@router.get("/{instruction_set_id}/diff")
def diff(
    instruction_set_id: int,
    from_version: int = Query(alias="from", ge=1),
    to_version: int = Query(alias="to", ge=1),
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> dict[str, Any]:
    """Step-level diff between two stored versions."""
    return service.diff_versions(session, instruction_set_id, from_version, to_version)


@router.post("/{instruction_set_id}/branch", response_model=InstructionSetOut, status_code=201)
def branch(
    instruction_set_id: int,
    body: BranchIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> InstructionSet:
    """Copy a version (default: the published one) into a new draft for experimentation."""
    return service.branch(session, principal, instruction_set_id, body.name, body.from_version)


@router.get("/{instruction_set_id}/branches", response_model=list[InstructionSetSummary])
def list_branches(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> Any:
    return service.get_instruction_set(session, instruction_set_id).branches


@router.post("/{instruction_set_id}/merge", response_model=MergeOut)
def merge(
    instruction_set_id: int,
    body: MergeIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> MergeOut:
    """Merge this branch into its parent; 409 lists the conflicting steps and fields."""
    parent, edit, summary = service.merge(
        session, principal, instruction_set_id, body.reason, body.expected_parent_version
    )
    return MergeOut(instruction_set=parent, edit=EditOut.model_validate(edit), summary=summary)


@router.get("/{instruction_set_id}/drift", response_model=DriftOut)
def get_drift(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> DriftOut:
    instruction_set = service.get_instruction_set(session, instruction_set_id)
    return DriftOut(**drift.drift_report(session, instruction_set))


@router.post("/{instruction_set_id}/drift/verify", response_model=list[DriftFlagOut])
def verify_drift(
    instruction_set_id: int,
    body: VerifyIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> Any:
    return service.reverify(session, principal, instruction_set_id, body.step_ids)


@router.get("/{instruction_set_id}/versions")
def list_versions(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> list[dict[str, Any]]:
    instruction_set = service.get_instruction_set(session, instruction_set_id)
    rows = session.scalars(
        select(InstructionSetVersion)
        .where(InstructionSetVersion.instruction_set_id == instruction_set.id)
        .order_by(InstructionSetVersion.version)
    ).all()
    return [
        {"version": r.version, "steps": len(r.document["steps"]), "created_at": r.created_at}
        for r in rows
    ]


@router.patch("/{instruction_set_id}", response_model=EditOut)
def edit(
    instruction_set_id: int,
    body: EditIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> Any:
    return service.apply_edit(
        session, principal, instruction_set_id, body.expected_version, body.reason, body.document
    )


@router.get("/{instruction_set_id}/edits", response_model=list[EditOut])
def list_edits(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> Any:
    return service.get_instruction_set(session, instruction_set_id).edits


def _transition_out(session: Session, instruction_set: InstructionSet) -> TransitionOut:
    return TransitionOut(
        instruction_set=instruction_set,
        approvals=service.count_approvals(session, instruction_set),
        required_approvals=instruction_set.required_approvals,
        missing_roles=service.missing_roles(session, instruction_set),
    )


@router.put("/{instruction_set_id}/policy", response_model=InstructionSetSummary)
def set_policy(
    instruction_set_id: int,
    body: PolicyIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> InstructionSet:
    return service.set_review_policy(
        session,
        principal,
        instruction_set_id,
        body.review_policy.model_dump(),
        body.required_approvals,
    )


@router.post("/{instruction_set_id}/submit", response_model=TransitionOut)
def submit(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> TransitionOut:
    instruction_set = service.get_instruction_set(session, instruction_set_id)
    action = "resubmit" if instruction_set.state.value == "changes_requested" else "submit"
    return _transition_out(
        session, service.transition(session, principal, instruction_set_id, action)
    )


@router.post("/{instruction_set_id}/review", response_model=TransitionOut)
def review(
    instruction_set_id: int,
    body: ReviewIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("reviewer")),
) -> TransitionOut:
    instruction_set, _ = service.review(
        session, principal, instruction_set_id, body.decision, body.comment
    )
    return _transition_out(session, instruction_set)


@router.get("/{instruction_set_id}/reviews", response_model=list[ReviewOut])
def list_reviews(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> Any:
    return service.get_instruction_set(session, instruction_set_id).reviews


@router.get("/{instruction_set_id}/audit", response_model=list[AuditOut])
def list_audit(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> Any:
    return service.get_instruction_set(session, instruction_set_id).audit


@router.post("/{instruction_set_id}/test-cases", response_model=TestCaseOut, status_code=201)
def add_test_case(
    instruction_set_id: int,
    body: TestCaseIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert", "reviewer")),
) -> Any:
    return service.add_test_case(
        session, principal, instruction_set_id, body.name, body.scenario, body.expectations
    )


@router.get("/{instruction_set_id}/test-cases", response_model=list[TestCaseOut])
def list_test_cases(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> Any:
    return service.get_instruction_set(session, instruction_set_id).test_cases


@router.post("/{instruction_set_id}/run-tests", response_model=TestRunOut)
def run_tests(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert", "reviewer")),
) -> Any:
    return service.run_tests(session, principal, instruction_set_id)


@router.get("/{instruction_set_id}/test-runs", response_model=list[TestRunOut])
def list_test_runs(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> Any:
    return service.get_instruction_set(session, instruction_set_id).test_runs


@router.post("/{instruction_set_id}/publish", response_model=PublishOut)
def publish(
    instruction_set_id: int,
    request: Request,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("admin")),
) -> PublishOut:
    instruction_set, publications = service.publish(
        session, principal, instruction_set_id, request.app.state.targets
    )
    return PublishOut(
        instruction_set=instruction_set,
        publications=[PublicationOut.model_validate(p) for p in publications],
    )


@router.post("/{instruction_set_id}/rollback", response_model=PublishOut)
def rollback(
    instruction_set_id: int,
    request: Request,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("admin")),
) -> PublishOut:
    instruction_set, publications = service.rollback(
        session, principal, instruction_set_id, request.app.state.targets
    )
    return PublishOut(
        instruction_set=instruction_set,
        publications=[PublicationOut.model_validate(p) for p in publications],
    )


@router.post("/{instruction_set_id}/retire", response_model=TransitionOut)
def retire(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("admin")),
) -> TransitionOut:
    return _transition_out(
        session, service.transition(session, principal, instruction_set_id, "retire")
    )


@router.get("/{instruction_set_id}/publications", response_model=list[PublicationOut])
def list_publications(
    instruction_set_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(read_roles),
) -> Any:
    return service.get_instruction_set(session, instruction_set_id).publications
