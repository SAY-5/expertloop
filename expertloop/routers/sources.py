from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from expertloop import drift
from expertloop.auth import Principal, require_role
from expertloop.db import get_session
from expertloop.models import Source
from expertloop.schemas import (
    DriftFlagOut,
    DriftScanOut,
    RehashIn,
    RehashOut,
    SourceIn,
    SourceOut,
)
from expertloop.service import NotFound
from expertloop.sources import register_source

router = APIRouter(prefix="/sources", tags=["sources"])


@router.post("", response_model=SourceOut, status_code=201)
def create_source(
    body: SourceIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert")),
) -> Source:
    existing = session.scalar(
        select(Source).where(Source.kind == body.kind, Source.ref == body.ref)
    )
    before = existing.content_hash if existing else None
    source = register_source(session, body.kind, body.ref, body.content, body.title)
    session.commit()
    if before is not None and before != source.content_hash:
        drift.scan_drift(session, principal, source.id)
    return source


@router.get("", response_model=list[SourceOut])
def list_sources(
    session: Session = Depends(get_session),
    _: Principal = Depends(require_role("expert", "reviewer")),
) -> list[Source]:
    return list(session.scalars(select(Source).order_by(Source.id)).all())


@router.post("/check-drift", response_model=DriftScanOut)
def check_drift(
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert", "reviewer")),
) -> DriftScanOut:
    """Re-scan every live instruction set against the registry's current hashes."""
    flags = drift.scan_drift(session, principal)
    return DriftScanOut(
        flags=[DriftFlagOut.model_validate(f) for f in flags],
        instruction_sets_flagged=len({f.instruction_set_id for f in flags}),
    )


@router.post("/{source_id}/rehash", response_model=RehashOut)
def rehash(
    source_id: int,
    body: RehashIn,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_role("expert", "reviewer")),
) -> RehashOut:
    """Re-hash one source (optionally with fresh content) and flag citing steps."""
    source = session.get(Source, source_id)
    if source is None:
        raise NotFound(f"source {source_id} not found")
    changed = drift.rehash_source(session, source, body.content)
    session.commit()
    flags = drift.scan_drift(session, principal, source.id) if changed else []
    return RehashOut(
        source=SourceOut.model_validate(source),
        changed=changed,
        flags=[DriftFlagOut.model_validate(f) for f in flags],
    )
