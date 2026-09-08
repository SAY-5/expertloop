import copy

from tests.conftest import headers
from tests.helpers import approved_and_green, edit, get_set, ingest, run_tests


def branch(client, set_id, **body):
    response = client.post(
        f"/instruction-sets/{set_id}/branch", json=body, headers=headers("expert")
    )
    assert response.status_code == 201, response.text
    return response.json()


def merge(client, branch_id, **body):
    return client.post(f"/instruction-sets/{branch_id}/merge", json=body, headers=headers("expert"))


def diff(client, set_id, from_version, to_version):
    response = client.get(
        f"/instruction-sets/{set_id}/diff",
        params={"from": from_version, "to": to_version},
        headers=headers("reviewer"),
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_diff_between_versions_is_step_level(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] = "Create the Okta account from the Workday record"
    doc["steps"][2]["decision_rules"][0]["then"] += " and note it in the ticket"
    removed = doc["steps"].pop(5)
    doc["steps"].append(
        {
            "id": "s7",
            "order": 7,
            "action": "Post the start date in #eng-announcements",
            "citations": removed["citations"],
            "decision_rules": [],
        }
    )
    doc["forbidden_actions"].append({"text": "share the laptop password", "citations": []})
    assert edit(client, set_id, doc, "restructure", expected_version=1).status_code == 200

    out = diff(client, set_id, 1, 2)
    assert out["summary"] == {
        "steps_added": 1,
        "steps_removed": 1,
        "steps_changed": 2,
        "entries_added": 1,
        "entries_removed": 0,
        "fields_changed": 0,
    }
    assert [s["id"] for s in out["steps"]["added"]] == ["s7"]
    assert [s["id"] for s in out["steps"]["removed"]] == ["s6"]
    changed = {c["id"]: c["fields"] for c in out["steps"]["changed"]}
    assert set(changed) == {"s1", "s3"}
    assert changed["s1"]["action"]["before"].startswith("Create the Okta account using")
    assert changed["s1"]["action"]["after"] == "Create the Okta account from the Workday record"
    assert list(changed["s3"]) == ["decision_rules"]
    assert out["sections"]["forbidden_actions"]["added"][0]["text"] == "share the laptop password"

    reverse = diff(client, set_id, 2, 1)
    assert [s["id"] for s in reverse["steps"]["removed"]] == ["s7"]
    assert (
        client.get(
            f"/instruction-sets/{set_id}/diff",
            params={"from": 1, "to": 9},
            headers=headers("expert"),
        ).status_code
        == 404
    )
    assert diff(client, set_id, 2, 2)["summary"]["steps_changed"] == 0


def test_branch_from_published_version_and_merge_back(client, fakes):
    set_id = approved_and_green(client)
    assert (
        client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin")).status_code
        == 200
    )

    child = branch(client, set_id, name="try a shorter welcome")
    assert (child["parent_id"], child["branched_from_version"], child["state"]) == (
        set_id,
        1,
        "draft",
    )
    assert (
        child["version"] == 1
        and child["document"]["steps"] == get_set(client, set_id)["document"]["steps"]
    )
    branches = client.get(
        f"/instruction-sets/{set_id}/branches", headers=headers("reviewer")
    ).json()
    assert [b["id"] for b in branches] == [child["id"]]
    assert (
        client.post(
            f"/instruction-sets/{child['id']}/branch", json={}, headers=headers("expert")
        ).status_code
        == 409
    ), "no branches of branches"

    doc = copy.deepcopy(child["document"])
    doc["steps"][5]["action"] = "Send a two-line welcome in Slack with the week-one links"
    doc["steps"][5]["expected_outcome"] = "the hire replies in the channel"
    assert edit(client, child["id"], doc, "shorter welcome", expected_version=1).status_code == 200
    assert (
        client.post(
            f"/instruction-sets/{child['id']}/test-cases",
            json={
                "name": "still creates the account",
                "scenario": {},
                "expectations": {"required_actions": ["Okta account"]},
            },
            headers=headers("reviewer"),
        ).status_code
        == 201
    )
    assert run_tests(client, child["id"])["status"] == "passed"
    assert get_set(client, set_id)["version"] == 1, (
        "experimenting on the branch leaves the parent alone"
    )

    merged = merge(client, child["id"], expected_parent_version=1)
    assert merged.status_code == 200, merged.text
    body = merged.json()
    assert (body["instruction_set"]["id"], body["instruction_set"]["version"]) == (set_id, 2)
    assert (
        body["instruction_set"]["state"] == "draft"
        and body["instruction_set"]["published_version"] == 1
    )
    assert body["edit"]["reason"] == f"merge branch {child['id']} (try a shorter welcome)"
    assert body["summary"]["steps_changed"] == 1
    parent = get_set(client, set_id)
    assert parent["document"]["steps"][5]["action"].startswith("Send a two-line welcome")
    assert parent["document"]["name"] == parent["name"]
    child_after = get_set(client, child["id"])
    assert child_after["merged_into_version"] == 2 and child_after["merged_at"] is not None
    assert merge(client, child["id"]).status_code == 409, "a branch merges once"
    audit = [
        a["action"]
        for a in client.get(f"/instruction-sets/{set_id}/audit", headers=headers("expert")).json()
    ]
    assert audit[-2:] == ["branched", "merge"]
    assert diff(client, set_id, 1, 2)["steps"]["changed"][0]["id"] == "s6"
    assert len(fakes.get("/_received").json()["webhook"]) == 1, "merging does not publish"


def test_merge_detects_conflicts_and_takes_one_sided_changes(client):
    set_id = ingest(client, "incident_triage_note.md")["instruction_set"]["id"]
    child = branch(client, set_id)
    assert child["name"] == "incident triage note (branch of v1)"

    # the parent moves on: s1 changes, s7 is removed, a precondition is added
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] = "Acknowledge the alert in PagerDuty within 2 minutes"
    doc["steps"].pop(6)
    doc["preconditions"].append({"text": "the on-call handover is done", "citations": []})
    assert edit(client, set_id, doc, "tighten ack time", expected_version=1).status_code == 200

    # the branch changes s1 differently and s2 on its own
    doc = copy.deepcopy(child["document"])
    doc["steps"][0]["action"] = "Acknowledge the alert in PagerDuty within 10 minutes"
    doc["steps"][1]["tool"] = "Datadog"
    assert edit(client, child["id"], doc, "loosen ack time", expected_version=1).status_code == 200

    stale = merge(client, child["id"], expected_parent_version=1)
    assert stale.status_code == 409 and stale.json()["current_version"] == 2

    conflict = merge(client, child["id"])
    assert conflict.status_code == 409, conflict.text
    conflicts = conflict.json()["conflicts"]
    assert [(c["step_id"], c["field"]) for c in conflicts] == [("s1", "action")]
    assert conflicts[0]["parent"].endswith("2 minutes") and conflicts[0]["branch"].endswith(
        "10 minutes"
    )
    assert get_set(client, set_id)["version"] == 2, "a conflicting merge changes nothing"
    events = client.get(f"/instruction-sets/{set_id}/audit", headers=headers("expert")).json()
    assert events[-1]["action"] == "merge_conflict"
    assert events[-1]["detail"]["conflicts"] == [
        {"kind": "step", "step_id": "s1", "field": "action"}
    ]

    # resolve on the branch by taking the parent's wording, then merge cleanly
    doc = copy.deepcopy(get_set(client, child["id"])["document"])
    doc["steps"][0]["action"] = "Acknowledge the alert in PagerDuty within 2 minutes"
    assert (
        edit(client, child["id"], doc, "take parent ack time", expected_version=2).status_code
        == 200
    )
    merged = merge(client, child["id"], reason="datadog dashboards")
    assert merged.status_code == 200, merged.text
    parent = get_set(client, set_id)["document"]
    assert [s["id"] for s in parent["steps"]] == ["s1", "s2", "s3", "s4", "s5", "s6"]
    assert parent["steps"][0]["action"].endswith("2 minutes")
    assert parent["steps"][1]["tool"] == "Datadog"
    assert parent["preconditions"][-1]["text"] == "the on-call handover is done"
    assert merged.json()["edit"]["reason"] == "datadog dashboards"
