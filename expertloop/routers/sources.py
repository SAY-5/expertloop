from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from expertloop.auth import Principal, require_role
from expertloop.db import get_session
from expertloop.models import Source
from expertloop.schemas import SourceIn, SourceOut
from expertloop.sources import register_source

router = APIRouter(prefix="/sources", tags=["sources"])


@router.post("", response_model=SourceOut, status_code=201)
def create_source(
    body: SourceIn,
    session: Session = Depends(get_session),
    _: Principal = Depends(require_role("expert")),
) -> Source:
    source = register_source(session, body.kind, body.ref, body.content, body.title)
    session.commit()
    return source


@router.get("", response_model=list[SourceOut])
def list_sources(
    session: Session = Depends(get_session),
    _: Principal = Depends(require_role("expert", "reviewer")),
) -> list[Source]:
    return list(session.scalars(select(Source).order_by(Source.id)).all())
