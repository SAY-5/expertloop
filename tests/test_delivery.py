"""Delivery: the Jira request shape, the idempotency key, and a failed rollback."""

import copy

from tests.conftest import WEBHOOK_SECRET, headers
from tests.helpers import approve, approved_and_green, edit, get_set, run_tests, submit


def publish(client, set_id):
    return client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))


def test_jira_comment_is_an_atlassian_document(client, fakes):
    set_id = approved_and_green(client)
    assert publish(client, set_id).status_code == 200
    comment = fakes.get("/_received").json()["jira_comments"][0]
    assert comment["body"]["type"] == "doc" and comment["body"]["version"] == 1
    assert [node["type"] for node in comment["body"]["content"]] == ["paragraph", "codeBlock"]
    assert comment["text"].startswith("ExpertLoop publish: New engineer onboarding checklist")
    assert "Follow these steps in order:" in comment["text"]


def test_fake_jira_refuses_a_plain_string_comment(fakes):
    response = fakes.post("/jira/rest/api/3/issue/OPS-1/comment", json={"body": "plain text"})
    assert response.status_code == 400
    assert "Atlassian Document Format" in response.json()["errorMessages"][0]


def test_retry_after_a_partial_failure_delivers_each_target_once(client, fakes):
    set_id = approved_and_green(client)
    client.app.state.targets[0].secret = "wrong-secret"
    failed = publish(client, set_id)
    assert failed.status_code == 409 and failed.json()["targets"] == ["webhook"]
    received = fakes.get("/_received").json()
    assert received["webhook"] == [] and len(received["jira_comments"]) == 1

    client.app.state.targets[0].secret = WEBHOOK_SECRET
    retried = publish(client, set_id)
    assert retried.status_code == 200, retried.text
    assert [(p["target"], p["status"]) for p in retried.json()["publications"]] == [
        ("webhook", "delivered")
    ]
    received = fakes.get("/_received").json()
    assert len(received["jira_comments"]) == 1, "the Jira comment is not posted twice"
    assert len(received["jira_attachments"]) == 1
    assert len(received["webhook"]) == 1
    assert received["webhook"][0]["payload"]["delivery_id"] == f"{set_id}:1:publish"
    assert get_set(client, set_id)["state"] == "published"
    publications = client.get(
        f"/instruction-sets/{set_id}/publications", headers=headers("reviewer")
    ).json()
    assert [(p["target"], p["status"]) for p in publications] == [
        ("webhook", "failed"),
        ("jira", "delivered"),
        ("webhook", "delivered"),
    ]


def test_failed_rollback_is_audited_and_leaves_the_live_version_alone(client):
    set_id = approved_and_green(client)
    assert publish(client, set_id).status_code == 200
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] += " (v2)"
    assert edit(client, set_id, doc, "revise the live set", expected_version=1).status_code == 200
    submit(client, set_id)
    approve(client, set_id)
    run_tests(client, set_id)
    assert publish(client, set_id).json()["instruction_set"]["published_version"] == 2

    client.app.state.targets[0].secret = "wrong-secret"
    rolled = client.post(f"/instruction-sets/{set_id}/rollback", headers=headers("admin"))
    assert rolled.status_code == 409 and "webhook" in rolled.json()["detail"]
    assert get_set(client, set_id)["published_version"] == 2
    audit = client.get(f"/instruction-sets/{set_id}/audit", headers=headers("reviewer")).json()
    assert audit[-1]["action"] == "rollback_failed"
    assert audit[-1]["detail"]["targets"] == ["webhook"]
    assert audit[-1]["detail"]["version"] == 1
