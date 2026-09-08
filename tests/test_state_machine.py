import pytest

from expertloop.models import State
from expertloop.workflow import EDITABLE_STATES, IllegalTransition, assert_transition


def test_happy_path_transitions():
    state = State.draft
    for action in ("submit", "request_changes", "resubmit", "approve", "publish", "retire"):
        state = assert_transition(action, state)
    assert state == State.retired


@pytest.mark.parametrize(
    ("action", "state"),
    [
        ("publish", State.draft),
        ("approve", State.draft),
        ("submit", State.in_review),
        ("retire", State.approved),
        ("resubmit", State.draft),
        ("unknown", State.draft),
    ],
)
def test_illegal_transitions_are_rejected(action: str, state: State):
    with pytest.raises(IllegalTransition) as excinfo:
        assert_transition(action, state)
    assert excinfo.value.current == state


def test_published_sets_can_be_revised_but_retired_sets_cannot():
    assert State.published in EDITABLE_STATES
    assert State.retired not in EDITABLE_STATES
    assert State.in_review not in EDITABLE_STATES
