from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from expertloop import service
from expertloop.auth import Principal, require_role
from expertloop.config import get_settings
from expertloop.db import get_session
from expertloop.models import Note
from expertloop.schemas import IngestOut, NoteIn, NoteOut

router = APIRouter(prefix="/notes", tags=["notes"])


@router.post("", response_model=IngestOut, status_code=201)
def ingest(
    body: NoteIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> IngestOut:
    required = body.required_approvals or get_settings().default_required_approvals
    note, instruction_set, coverage, linked = service.ingest_note(
        session, principal, body.title, body.body, required
    )
    return IngestOut(
        note=NoteOut.model_validate(note),
        instruction_set=instruction_set,
        coverage=coverage,
        sources_linked=linked,
    )


@router.get("", response_model=list[NoteOut])
def list_notes(
    session: Session = Depends(get_session),
    _: Principal = Depends(require_role("expert", "reviewer")),
) -> list[Note]:
    return list(session.scalars(select(Note).order_by(Note.id)).all())


@router.get("/{note_id}", response_model=NoteOut)
def get_note(
    note_id: int,
    session: Session = Depends(get_session),
    _: Principal = Depends(require_role("expert", "reviewer")),
) -> Note:
    note = session.get(Note, note_id)
    if note is None:
        raise HTTPException(404, f"note {note_id} not found")
    return note
