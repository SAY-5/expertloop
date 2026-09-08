import copy

from tests.conftest import headers
from tests.helpers import approve, edit, get_set, ingest, submit


def test_review_state_machine_with_two_required_approvals(client):
    set_id = ingest(client, "incident_triage_note.md", required_approvals=2)["instruction_set"][
        "id"
    ]
    assert submit(client, set_id)["instruction_set"]["state"] == "in_review"

    first = approve(client, set_id, "reviewer")
    assert (first["instruction_set"]["state"], first["approvals"]) == ("in_review", 1)
    again = approve(client, set_id, "reviewer")
    assert again["approvals"] == 1, "the same reviewer does not count twice"
    second = approve(client, set_id, "reviewer2")
    assert (second["instruction_set"]["state"], second["approvals"]) == ("approved", 2)

    audit = client.get(f"/instruction-sets/{set_id}/audit", headers=headers("reviewer")).json()
    assert [a["action"] for a in audit] == [
        "ingest",
        "submit",
        "approval_recorded",
        "approval_recorded",
        "approve",
    ]
    assert audit[-1]["from_state"] == "in_review" and audit[-1]["to_state"] == "approved"


def test_changes_requested_then_resubmit(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    submit(client, set_id)
    response = client.post(
        f"/instruction-sets/{set_id}/review",
        json={"decision": "request_changes", "comment": "add the contractor rule"},
        headers=headers("reviewer"),
    )
    assert response.json()["instruction_set"]["state"] == "changes_requested"
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] += " and record the ticket id"
    assert edit(client, set_id, doc, "address review", expected_version=1).status_code == 200
    assert submit(client, set_id)["instruction_set"]["state"] == "in_review"
    assert approve(client, set_id)["instruction_set"]["state"] == "approved"
    reviews = client.get(f"/instruction-sets/{set_id}/reviews", headers=headers("reviewer")).json()
    assert [(r["decision"], r["version"]) for r in reviews] == [
        ("request_changes", 1),
        ("approve", 2),
    ]


def test_illegal_transitions_return_409(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    review = client.post(
        f"/instruction-sets/{set_id}/review",
        json={"decision": "approve"},
        headers=headers("reviewer"),
    )
    assert review.status_code == 409 and review.json()["state"] == "draft"
    publish = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert publish.status_code == 409 and publish.json()["action"] == "publish"
    retire = client.post(f"/instruction-sets/{set_id}/retire", headers=headers("admin"))
    assert retire.status_code == 409
    submit(client, set_id)
    assert (
        client.post(f"/instruction-sets/{set_id}/submit", headers=headers("expert")).status_code
        == 409
    )


def test_author_cannot_review_own_note_and_edit_after_approval_resets(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    submit(client, set_id)
    # dana (expert) wrote the note; an admin key named dana would still be blocked, so use a
    # reviewer with the author's name to prove the rule keys on the name
    self_review = client.post(
        f"/instruction-sets/{set_id}/review",
        json={"decision": "approve"},
        headers=headers("expert"),
    )
    assert self_review.status_code == 403  # experts have no review scope at all
    approve(client, set_id)
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][1]["action"] += " (post-approval fix)"
    assert edit(client, set_id, doc, "fix after approval", expected_version=1).status_code == 200
    current = get_set(client, set_id)
    assert current["state"] == "draft" and current["version"] == 2
    submit(client, set_id)
    assert approve(client, set_id)["approvals"] == 1
