"""Source drift detection.

A citation stores the hash of its source at compile or edit time. When a registered
source is re-hashed and the hash differs, every step that cites it is flagged as stale.
Open flags block publication until an expert re-verifies the step or edits the set so
the citation carries the current hash. The scan runs on demand (rehash, check-drift)
and optionally on a schedule.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from expertloop.auth import Principal
from expertloop.models import AuditEvent, DriftFlag, InstructionSet, Source, State, utcnow
from expertloop.sources import content_hash

log = structlog.get_logger()
SCHEDULER = Principal(name="scheduler", role="admin")
SCANNED_STATES = frozenset(s for s in State if s != State.retired)


def rehash_source(session: Session, source: Source, content: str | None = None) -> bool:
    """Recompute the source hash (optionally with new content). Return True when it changed."""
    if content is not None:
        source.content = content
    new_hash = content_hash(source.content, source.ref)
    changed = new_hash != source.content_hash
    source.content_hash = new_hash
    source.last_checked_at = utcnow()
    session.flush()
    return changed


def open_flags(session: Session, instruction_set: InstructionSet) -> list[DriftFlag]:
    return list(
        session.scalars(
            select(DriftFlag)
            .where(
                DriftFlag.instruction_set_id == instruction_set.id,
                DriftFlag.resolved_at.is_(None),
            )
            .order_by(DriftFlag.id)
        ).all()
    )


def _latest_flags(session: Session, instruction_set: InstructionSet) -> dict[tuple[str, int], Any]:
    latest: dict[tuple[str, int], DriftFlag] = {}
    for flag in session.scalars(
        select(DriftFlag)
        .where(DriftFlag.instruction_set_id == instruction_set.id)
        .order_by(DriftFlag.id)
    ).all():
        latest[(flag.step_id, flag.source_id)] = flag
    return latest


def _step_sources(instruction_set: InstructionSet) -> list[tuple[str, int, str]]:
    seen: set[tuple[str, int]] = set()
    out: list[tuple[str, int, str]] = []
    for step in instruction_set.document.get("steps", []):
        for cite in step.get("citations", []):
            source_id = cite.get("source_id")
            if not source_id or (step["id"], source_id) in seen:
                continue
            seen.add((step["id"], source_id))
            out.append((step["id"], source_id, cite.get("source_hash", "")))
    return out


def scan_instruction_set(
    session: Session, actor: Principal, instruction_set: InstructionSet, source_id: int | None
) -> list[DriftFlag]:
    """Flag steps whose cited hash differs from the registry. Return the new flags."""
    ids = {sid for _, sid, _ in _step_sources(instruction_set)}
    if source_id is not None:
        ids &= {source_id}
    if not ids:
        return []
    sources = {s.id: s for s in session.scalars(select(Source).where(Source.id.in_(ids))).all()}
    latest = _latest_flags(session, instruction_set)
    created: list[DriftFlag] = []
    for step_id, sid, cited in _step_sources(instruction_set):
        source = sources.get(sid)
        if source is None or source.content_hash == cited:
            continue
        previous = latest.get((step_id, sid))
        if previous is not None and (
            previous.resolved_at is None or previous.current_hash == source.content_hash
        ):
            continue  # already open, or already re-verified against this exact hash
        flag = DriftFlag(
            instruction_set_id=instruction_set.id,
            step_id=step_id,
            source_id=sid,
            cited_hash=cited,
            current_hash=source.content_hash,
            detected_by=actor.name,
        )
        session.add(flag)
        created.append(flag)
    if created:
        session.flush()
        session.add(
            AuditEvent(
                instruction_set_id=instruction_set.id,
                actor=actor.name,
                action="drift_detected",
                from_state=instruction_set.state.value,
                to_state=instruction_set.state.value,
                detail={
                    "steps": [f.step_id for f in created],
                    "sources": sorted({f.source_id for f in created}),
                },
            )
        )
    return created


def scan_drift(session: Session, actor: Principal, source_id: int | None = None) -> list[DriftFlag]:
    """Scan every live instruction set (optionally for one source) and commit new flags."""
    created: list[DriftFlag] = []
    for instruction_set in session.scalars(
        select(InstructionSet)
        .where(InstructionSet.state.in_(SCANNED_STATES))
        .order_by(InstructionSet.id)
    ).all():
        created.extend(scan_instruction_set(session, actor, instruction_set, source_id))
    session.commit()
    return created


def resolve_flags(
    session: Session,
    actor: Principal,
    instruction_set: InstructionSet,
    step_ids: set[str] | None,
    resolution: str,
) -> list[DriftFlag]:
    """Close open flags (all, or for the given steps) with the given resolution."""
    resolved: list[DriftFlag] = []
    for flag in open_flags(session, instruction_set):
        if step_ids is not None and flag.step_id not in step_ids:
            continue
        flag.resolved_at = utcnow()
        flag.resolved_by = actor.name
        flag.resolution = resolution
        resolved.append(flag)
    return resolved


def resolve_after_edit(
    session: Session, actor: Principal, instruction_set: InstructionSet
) -> list[DriftFlag]:
    """After an edit, close flags whose step now cites the registry's current hash."""
    current = {(step_id, sid): cited for step_id, sid, cited in _step_sources(instruction_set)}
    resolved: list[DriftFlag] = []
    for flag in open_flags(session, instruction_set):
        cited = current.get((flag.step_id, flag.source_id))
        if cited is None or cited == flag.current_hash:
            flag.resolved_at = utcnow()
            flag.resolved_by = actor.name
            flag.resolution = "edited"
            resolved.append(flag)
    return resolved


def drift_report(session: Session, instruction_set: InstructionSet) -> dict[str, Any]:
    flags = list(instruction_set.drift_flags)
    open_ = [f for f in flags if f.resolved_at is None]
    return {
        "instruction_set_id": instruction_set.id,
        "stale": bool(open_),
        "stale_steps": sorted({f.step_id for f in open_}),
        "open": len(open_),
        "resolved": len(flags) - len(open_),
        "flags": flags,
    }


Job = Callable[[Session, Principal], list[Any]]


class DriftScheduler:
    """Background thread that re-scans all sources every ``interval`` seconds.

    Extra ``jobs`` (session, actor) run on the same tick; each returns what it touched.
    """

    def __init__(
        self,
        session_factory: Callable[[], Session],
        interval: float,
        jobs: list[Job] | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.interval = interval
        self.jobs: list[Job] = [scan_drift, *(jobs or [])]
        self.runs = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def tick(self) -> int:
        touched = 0
        with self.session_factory() as session:
            for job in self.jobs:
                touched += len(job(session, SCHEDULER))
        self.runs += 1
        if touched:
            log.info("scheduler_tick", touched=touched)
        return touched

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001  (keep the scheduler alive)
                log.warning("drift_scan_failed", error=str(exc))

    def start(self) -> None:
        if self.interval <= 0 or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="drift-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
