from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from expertloop import reviews
from expertloop.auth import Principal, require_role
from expertloop.db import get_session
from expertloop.schemas import EscalationOut, InstructionSetSummary, WorkloadOut

router = APIRouter(prefix="/reviews", tags=["reviews"])


def _reviewers(request: Request) -> list[tuple[str, str]]:
    return [(k.name, k.role) for k in request.app.state.api_keys if k.role in reviews.REVIEW_ROLES]


@router.get("/workload", response_model=WorkloadOut)
def workload(
    request: Request,
    session: Session = Depends(get_session),
    _: Principal = Depends(require_role("reviewer")),
) -> WorkloadOut:
    """Sets waiting for review, their deadlines, and what each reviewer still owes."""
    return WorkloadOut(**reviews.workload(session, _reviewers(request)))


@router.post("/escalate", response_model=EscalationOut)
def escalate(
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("reviewer")),
) -> EscalationOut:
    """Escalate every set whose review deadline has passed (also run by the scheduler)."""
    escalated = reviews.escalate_overdue(session, principal)
    return EscalationOut(escalated=[InstructionSetSummary.model_validate(s) for s in escalated])
