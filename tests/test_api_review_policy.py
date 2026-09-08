import copy

from expertloop import db
from expertloop.drift import DriftScheduler
from expertloop.reviews import escalate_overdue
from tests.conftest import headers
from tests.helpers import approve, edit, get_set, ingest, submit


def review(client, set_id, who, decision="approve"):
    return client.post(
        f"/instruction-sets/{set_id}/review",
        json={"decision": decision, "comment": "checked"},
        headers=headers(who),
    )


def set_policy(client, set_id, policy, required_approvals=None):
    return client.put(
        f"/instruction-sets/{set_id}/policy",
        json={"review_policy": policy, "required_approvals": required_approvals},
        headers=headers("expert"),
    )


def test_author_of_the_current_version_cannot_approve_it(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] += " (ops fix)"
    assert (
        client.patch(
            f"/instruction-sets/{set_id}",
            json={"expected_version": 1, "reason": "ops fix", "document": doc},
            headers=headers("admin"),
        ).status_code
        == 200
    )
    submit(client, set_id)
    rejected = review(client, set_id, "admin")
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["author"] == "ops" and "self-approval" in rejected.json()["detail"]
    assert client.get(f"/instruction-sets/{set_id}/reviews", headers=headers("admin")).json() == []
    assert approve(client, set_id)["instruction_set"]["state"] == "approved"

    # the same edit is approvable by its author once the policy allows it
    other = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    assert set_policy(client, other, {"allow_self_approval": True}).status_code == 200
    doc = copy.deepcopy(get_set(client, other)["document"])
    doc["steps"][0]["action"] += " (ops fix)"
    client.patch(
        f"/instruction-sets/{other}",
        json={"expected_version": 1, "reason": "ops fix", "document": doc},
        headers=headers("admin"),
    )
    submit(client, other)
    assert review(client, other, "admin").json()["instruction_set"]["state"] == "approved"


def test_required_reviewer_role_is_enforced(client):
    out = ingest(client, "incident_triage_note.md")
    set_id = out["instruction_set"]["id"]
    assert set_policy(client, set_id, {"required_roles": ["admin"]}, 2).status_code == 200
    bad = set_policy(client, set_id, {"required_roles": ["expert"]})
    assert bad.status_code == 422 and bad.json()["problems"] == ["unknown reviewer role: expert"]
    submit(client, set_id)
    assert set_policy(client, set_id, {}).status_code == 409, "policy is frozen during review"

    first = review(client, set_id, "reviewer").json()
    assert (first["instruction_set"]["state"], first["approvals"], first["missing_roles"]) == (
        "in_review",
        1,
        ["admin"],
    )
    second = review(client, set_id, "reviewer2").json()
    assert second["approvals"] == 2 and second["instruction_set"]["state"] == "in_review"
    assert second["missing_roles"] == ["admin"], "two reviewers do not replace the admin"
    third = review(client, set_id, "admin").json()
    assert (third["instruction_set"]["state"], third["approvals"], third["missing_roles"]) == (
        "approved",
        3,
        [],
    )
    audit = client.get(f"/instruction-sets/{set_id}/audit", headers=headers("reviewer")).json()
    assert [
        a["detail"].get("missing_roles") for a in audit if a["action"] == "approval_recorded"
    ] == [
        ["admin"],
        ["admin"],
    ]
    assert audit[1]["action"] == "policy_set"
    assert audit[1]["detail"]["review_policy"]["required_roles"] == ["admin"]


def test_overdue_review_escalates_and_shows_in_workload(client):
    quick = ingest(
        client,
        "refund_handling_sop.md",
        review_policy={"review_deadline_hours": 0},
    )["instruction_set"]["id"]
    slow = ingest(
        client,
        "onboarding_checklist.md",
        review_policy={"review_deadline_hours": 48},
    )["instruction_set"]["id"]
    untimed = ingest(client, "incident_triage_note.md")["instruction_set"]["id"]
    for set_id in (quick, slow, untimed):
        submitted = submit(client, set_id)["instruction_set"]
        assert (submitted["review_deadline_at"] is not None) == (set_id != untimed)

    escalated = client.post("/reviews/escalate", headers=headers("reviewer"))
    assert escalated.status_code == 200, escalated.text
    assert [s["id"] for s in escalated.json()["escalated"]] == [quick]
    assert get_set(client, quick)["escalated_at"] is not None
    assert client.post("/reviews/escalate", headers=headers("reviewer")).json()["escalated"] == []
    audit = client.get(f"/instruction-sets/{quick}/audit", headers=headers("reviewer")).json()
    event = next(a for a in audit if a["action"] == "review_escalated")
    assert event["actor"] == "ravi" and event["detail"]["approvals"] == 0

    workload = client.get("/reviews/workload", headers=headers("reviewer")).json()
    queue = {q["instruction_set_id"]: q for q in workload["queue"]}
    assert [q["instruction_set_id"] for q in workload["queue"]] == [quick, slow, untimed]
    assert (queue[quick]["overdue"], queue[quick]["escalated"]) == (True, True)
    assert (queue[slow]["overdue"], queue[slow]["escalated"]) == (False, False)
    assert queue[quick]["waiting_on"] == ["mei", "ops", "ravi"]
    ravi = next(r for r in workload["reviewers"] if r["name"] == "ravi")
    assert (ravi["pending"], ravi["overdue"], ravi["decided"]) == ([quick, slow, untimed], 1, 0)

    approve(client, quick)
    workload = client.get("/reviews/workload", headers=headers("reviewer")).json()
    ravi = next(r for r in workload["reviewers"] if r["name"] == "ravi")
    assert (ravi["pending"], ravi["overdue"], ravi["decided"]) == ([slow, untimed], 0, 1)
    assert client.get("/reviews/workload", headers=headers("expert")).status_code == 403

    # a request for changes and a resubmit restart the clock, and the scheduler escalates too
    review(client, slow, "reviewer", "request_changes")
    doc = copy.deepcopy(get_set(client, slow)["document"])
    doc["steps"][0]["action"] += " (fix)"
    edit(client, slow, doc, "fix", expected_version=1)
    set_policy(client, slow, {"review_deadline_hours": 0})
    resubmitted = submit(client, slow)["instruction_set"]
    assert resubmitted["escalated_at"] is None
    scheduler = DriftScheduler(db.session_factory(), interval=0, jobs=[escalate_overdue])
    assert scheduler.tick() == 1
    assert get_set(client, slow)["escalated_at"] is not None
