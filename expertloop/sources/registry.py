"""Source registry: referenced documents, tickets and URLs with content hashes.

A citation stores the source's hash at compile or edit time. Verification compares
that stored hash with the registry's current hash, so a changed policy document is
visible as an unverified citation instead of silently drifting.
"""

from __future__ import annotations

import hashlib
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from expertloop.models import Source


def content_hash(content: str | None, ref: str) -> str:
    payload = content if content is not None else f"ref:{ref}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def register_source(
    session: Session,
    kind: str,
    ref: str,
    content: str | None = None,
    title: str | None = None,
) -> Source:
    existing = session.scalar(select(Source).where(Source.kind == kind, Source.ref == ref))
    if existing is not None:
        if content is not None and content != existing.content:
            existing.content = content
            existing.content_hash = content_hash(content, ref)
        if title is not None:
            existing.title = title
        return existing
    source = Source(
        kind=kind, ref=ref, title=title, content=content, content_hash=content_hash(content, ref)
    )
    session.add(source)
    session.flush()
    return source


def resolve_citations(session: Session, document: dict[str, Any]) -> int:
    """Attach ``source_id`` and ``source_hash`` to every citation with a source reference.

    Unknown sources are registered with the reference itself as the hashed payload so the
    link is always resolvable. Returns the number of citations resolved.
    """
    resolved = 0
    for cite in iter_citations(document):
        ref = cite.get("source_ref")
        if not ref:
            continue
        source = register_source(session, cite.get("source_kind", "doc"), ref)
        cite["source_id"] = source.id
        cite["source_hash"] = source.content_hash
        resolved += 1
    return resolved


def iter_citations(document: dict[str, Any]):
    for key in ("preconditions", "steps", "decision_rules", "forbidden_actions", "outcomes"):
        for entry in document.get(key, []):
            yield from entry.get("citations", [])


def verify_citations(session: Session, document: dict[str, Any]) -> list[dict[str, Any]]:
    """Return a verification report for every citation in the document."""
    ids = {c["source_id"] for c in iter_citations(document) if c.get("source_id")}
    sources = (
        {s.id: s for s in session.scalars(select(Source).where(Source.id.in_(ids))).all()}
        if ids
        else {}
    )
    report: list[dict[str, Any]] = []
    for key in ("preconditions", "steps", "decision_rules", "forbidden_actions", "outcomes"):
        for entry in document.get(key, []):
            for cite in entry.get("citations", []):
                row = dict(cite)
                row["section"] = key
                row["entry"] = entry.get("id") or entry.get("text") or entry.get("condition")
                if cite.get("source_id"):
                    source = sources.get(cite["source_id"])
                    row["verified"] = bool(
                        source and source.content_hash == cite.get("source_hash")
                    )
                else:
                    row["verified"] = True  # a bare line-range citation is always verifiable
                report.append(row)
    return report
