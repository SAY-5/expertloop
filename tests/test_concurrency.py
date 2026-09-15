"""Two writers on one instruction set at the same time.

``service.get_instruction_set(..., for_update=True)`` takes a row lock in every function
that writes state, so that two approvals, two publishes, or an edit racing a merge are
serialised by PostgreSQL rather than each deciding from a snapshot that does not include
the other's uncommitted work.

Neither test below fails if that lock is removed, and it is worth saying why. A reviewer's
decision is a ``review_decisions`` row whose foreign key makes PostgreSQL take a
``FOR KEY SHARE`` lock on the instruction set it points at, and every other write path
updates the row itself; both already conflict with a held ``FOR UPDATE``. The lock closes
the window between counting approvals and committing them, which these tests guard against
regression but do not isolate.
"""

import threading
import time

from expertloop import db, service
from expertloop.auth import Principal
from tests.conftest import KEYS, headers
from tests.helpers import get_set, ingest, submit

LOCK_HOLD_SECONDS = 0.4


def principal(role: str) -> Principal:
    key = KEYS[role]
    return Principal(name=key.name, role=key.role)


def test_a_review_serialises_behind_a_held_row_lock(client):
    """A reviewer's transaction waits while another transaction holds the set's row."""
    set_id = ingest(client, "refund_handling_sop.md", required_approvals=2)["instruction_set"]["id"]
    submit(client, set_id)

    holding = threading.Event()
    released = threading.Event()

    def hold_the_row() -> None:
        with db.session_factory()() as session:
            service.get_instruction_set(session, set_id, for_update=True)
            holding.set()
            time.sleep(LOCK_HOLD_SECONDS)
            session.commit()
            released.set()

    holder = threading.Thread(target=hold_the_row, name="row-holder")
    holder.start()
    try:
        assert holding.wait(timeout=10), "the holding thread never took the lock"
        started = time.monotonic()
        with db.session_factory()() as session:
            service.review(session, principal("reviewer"), set_id, "approve", "checked")
        waited = time.monotonic() - started
    finally:
        holder.join(timeout=10)

    assert released.is_set()
    assert waited >= LOCK_HOLD_SECONDS / 2, f"the review did not wait for the row ({waited:.3f}s)"
    reviews = client.get(f"/instruction-sets/{set_id}/reviews", headers=headers("reviewer")).json()
    assert [r["reviewer"] for r in reviews] == ["ravi"]
    assert get_set(client, set_id)["state"] == "in_review", "one of two approvals is not enough"


def test_two_reviewers_approving_at_once_reach_approved(client):
    """End to end: two sessions approve together, and the set is approved with two decisions."""
    set_id = ingest(client, "incident_triage_note.md", required_approvals=2)["instruction_set"][
        "id"
    ]
    submit(client, set_id)

    both_ready = threading.Barrier(2, timeout=15)
    errors: list[BaseException] = []

    def approve_in_its_own_session(role: str) -> None:
        try:
            with db.session_factory()() as session:
                both_ready.wait()
                service.review(
                    session,
                    principal(role),
                    set_id,
                    "approve",
                    "verified against the source documents",
                )
        except BaseException as exc:  # noqa: BLE001  (reported through the list)
            errors.append(exc)

    threads = [
        threading.Thread(target=approve_in_its_own_session, args=(role,))
        for role in ("reviewer", "reviewer2")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert [repr(error) for error in errors] == []
    assert not any(thread.is_alive() for thread in threads)
    assert get_set(client, set_id)["state"] == "approved"
    reviews = client.get(f"/instruction-sets/{set_id}/reviews", headers=headers("reviewer")).json()
    assert sorted(r["reviewer"] for r in reviews) == ["mei", "ravi"]
    assert [r["decision"] for r in reviews] == ["approve", "approve"]
