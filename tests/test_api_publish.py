import copy

from tests.conftest import headers
from tests.helpers import (
    add_case,
    approve,
    approved_and_green,
    edit,
    get_set,
    ingest,
    run_tests,
    submit,
)

HIGH_VALUE_CASE = (
    "high value refund needs manager approval",
    {"facts": {"amount": 800, "reason": "damaged"}},
    {"forbidden_actions": ["Issue the refund"], "required_actions": ["manager"], "must_halt": True},
)


def test_failing_test_blocks_publish_until_fixed(client, fakes):
    set_id = ingest(client, "refund_handling_sop.md")["instruction_set"]["id"]
    add_case(client, set_id, *HIGH_VALUE_CASE)
    add_case(
        client,
        set_id,
        "fraud escalates",
        {"facts": {"reason": "fraud"}},
        {"required_actions": ["risk team"], "must_halt": True},
    )
    run = run_tests(client, set_id)
    assert (run["status"], run["passed"], run["failed"]) == ("failed", 1, 1)
    assert run["results"][0]["failures"][1] == "forbidden action taken: 'Issue the refund'"

    submit(client, set_id)
    approve(client, set_id)
    blocked = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert blocked.status_code == 409
    assert blocked.json()["failing_cases"] == ["high value refund needs manager approval"]
    assert get_set(client, set_id)["state"] == "approved"
    assert fakes.get("/_received").json()["webhook"] == []

    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][3]["decision_rules"].append(
        {
            "condition": "amount is over 500",
            "then": "request manager approval and stop",
            "halts": True,
        }
    )
    assert (
        edit(client, set_id, doc, "manager approval above 500", expected_version=1).status_code
        == 200
    )
    submit(client, set_id)
    approve(client, set_id)
    stale_run = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert stale_run.status_code == 409 and "covers version 1" in stale_run.json()["detail"]

    assert run_tests(client, set_id)["status"] == "passed"
    published = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert published.status_code == 200, published.text
    body = published.json()
    assert body["instruction_set"]["state"] == "published"
    assert body["instruction_set"]["published_version"] == 2
    assert [(p["target"], p["status"]) for p in body["publications"]] == [
        ("webhook", "delivered"),
        ("jira", "delivered"),
    ]
    assert body["publications"][0]["receipt"]["signature_valid"] is True
    assert body["publications"][1]["receipt"]["comment"]["id"]

    received = fakes.get("/_received").json()
    assert received["webhook"][0]["payload"]["version"] == 2
    assert (
        received["webhook"][0]["payload"]["document"]["steps"][3]["decision_rules"][0]["halts"]
        is True
    )
    assert received["jira_comments"][0]["issue"] == "OPS-1"
    assert received["jira_attachments"][0]["filename"] == f"instruction-set-{set_id}-v2.json"
    audit = [
        a["action"]
        for a in client.get(f"/instruction-sets/{set_id}/audit", headers=headers("reviewer")).json()
    ]
    assert audit.count("publish_blocked") == 2 and audit[-1] == "publish"


def test_publish_requires_a_test_run(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    submit(client, set_id)
    approve(client, set_id)
    response = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert response.status_code == 409 and "no test run" in response.json()["detail"]


def test_rollback_redelivers_previous_version(client, fakes):
    set_id = approved_and_green(client)
    assert (
        client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin")).status_code
        == 200
    )
    no_previous = client.post(f"/instruction-sets/{set_id}/rollback", headers=headers("admin"))
    assert no_previous.status_code == 409

    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] += " (v2)"
    assert edit(client, set_id, doc, "revise live set", expected_version=1).status_code == 200
    assert get_set(client, set_id)["state"] == "draft"
    assert get_set(client, set_id)["published_version"] == 1
    submit(client, set_id)
    approve(client, set_id)
    run_tests(client, set_id)
    assert (
        client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin")).json()[
            "instruction_set"
        ]["published_version"]
        == 2
    )

    rolled = client.post(f"/instruction-sets/{set_id}/rollback", headers=headers("admin"))
    assert rolled.status_code == 200, rolled.text
    assert rolled.json()["instruction_set"]["published_version"] == 1
    assert [p["action"] for p in rolled.json()["publications"]] == ["rollback", "rollback"]
    payloads = [w["payload"] for w in fakes.get("/_received").json()["webhook"]]
    assert [(p["action"], p["version"]) for p in payloads] == [
        ("publish", 1),
        ("publish", 2),
        ("rollback", 1),
    ]
    assert payloads[-1]["rolled_back_from"] == 2
    assert "(v2)" not in payloads[-1]["document"]["steps"][0]["action"]
    publications = client.get(
        f"/instruction-sets/{set_id}/publications", headers=headers("reviewer")
    ).json()
    assert len(publications) == 6
    retired = client.post(f"/instruction-sets/{set_id}/retire", headers=headers("admin"))
    assert retired.json()["instruction_set"]["state"] == "retired"


def test_target_failure_keeps_set_approved(client, fakes):
    set_id = approved_and_green(client)
    client.app.state.targets[0].secret = "wrong-secret"
    response = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert response.status_code == 409 and response.json()["targets"] == ["webhook"]
    assert get_set(client, set_id)["state"] == "approved"
    publications = client.get(
        f"/instruction-sets/{set_id}/publications", headers=headers("reviewer")
    ).json()
    assert [(p["target"], p["status"]) for p in publications] == [
        ("webhook", "failed"),
        ("jira", "delivered"),
    ]
