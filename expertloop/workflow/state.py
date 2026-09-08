"""Approval state machine for instruction sets.

    draft -> in_review -> changes_requested -> in_review -> approved -> published -> retired

Editing is allowed in ``draft``, ``changes_requested`` and ``approved``; an edit to an
approved set moves it back to ``draft`` so that approvals are collected again for the
new version. Publishing additionally requires a green test run on the current version,
which is enforced by the service layer, not by the transition table.
"""

from __future__ import annotations

from expertloop.models import State

TRANSITIONS: dict[str, tuple[State, State]] = {
    "submit": (State.draft, State.in_review),
    "resubmit": (State.changes_requested, State.in_review),
    "request_changes": (State.in_review, State.changes_requested),
    "approve": (State.in_review, State.approved),
    "edit_after_approval": (State.approved, State.draft),
    "publish": (State.approved, State.published),
    "retire": (State.published, State.retired),
}

EDITABLE_STATES = frozenset({State.draft, State.changes_requested, State.approved})


class IllegalTransition(Exception):
    def __init__(self, action: str, current: State) -> None:
        self.action = action
        self.current = current
        super().__init__(f"cannot {action} an instruction set in state {current.value}")


def assert_transition(action: str, current: State) -> State:
    """Return the target state for ``action`` from ``current`` or raise IllegalTransition."""
    try:
        source, target = TRANSITIONS[action]
    except KeyError as exc:
        raise IllegalTransition(action, current) from exc
    if current != source:
        raise IllegalTransition(action, current)
    return target
