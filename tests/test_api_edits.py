import copy

from tests.conftest import headers
from tests.helpers import edit, get_set, ingest


def test_ingest_compiles_with_full_citation_coverage(client):
    out = ingest(client, "refund_handling_sop.md")
    assert out["coverage"]["coverage"] == 1.0 and out["coverage"]["steps"] == 5
    assert out["sources_linked"] == 2
    assert out["instruction_set"]["state"] == "draft"
    assert out["instruction_set"]["version"] == 1
    citations = client.get(
        f"/instruction-sets/{out['instruction_set']['id']}/citations", headers=headers("reviewer")
    ).json()
    assert citations["unverified"] == 0
    assert all(c["note_id"] == out["note"]["id"] for c in citations["citations"])
    prompt = client.get(
        f"/instruction-sets/{out['instruction_set']['id']}/prompt", headers=headers("reviewer")
    )
    assert prompt.text.startswith("# Refund handling for online orders")


def test_edit_records_history_and_bumps_version(client):
    set_id = ingest(client, "refund_handling_sop.md")["instruction_set"]["id"]
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][3]["decision_rules"].append(
        {
            "condition": "amount is over 500",
            "then": "request manager approval and stop",
            "halts": True,
        }
    )
    response = edit(client, set_id, doc, "add manager approval threshold", expected_version=1)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["from_version"], body["to_version"], body["author"]) == (1, 2, "dana")
    assert '+          "condition": "amount is over 500"' in body["diff"]

    current = get_set(client, set_id)
    assert current["version"] == 2
    assert (
        "if amount is over 500: request manager approval and stop"
        in current["document"]["agent_prompt"]
    )
    edits = client.get(f"/instruction-sets/{set_id}/edits", headers=headers("reviewer")).json()
    assert [e["reason"] for e in edits] == ["add manager approval threshold"]
    versions = client.get(
        f"/instruction-sets/{set_id}/versions", headers=headers("reviewer")
    ).json()
    assert [v["version"] for v in versions] == [1, 2]


def test_stale_version_is_rejected_with_conflict(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] += " (first edit)"
    assert edit(client, set_id, doc, "first", expected_version=1).status_code == 200
    doc["steps"][0]["action"] += " (second edit on stale base)"
    stale = edit(client, set_id, doc, "second", expected_version=1)
    assert stale.status_code == 409
    assert stale.json()["current_version"] == 2
    assert get_set(client, set_id)["version"] == 2


def test_edit_without_change_or_citation_is_rejected(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    assert edit(client, set_id, doc, "noop", expected_version=1).status_code == 409
    doc["steps"].append(
        {"id": "s7", "order": 7, "action": "uncited step", "citations": [], "decision_rules": []}
    )
    response = edit(client, set_id, doc, "add step", expected_version=1)
    assert response.status_code == 422
    assert response.json()["problems"] == ["step s7 has no citations"]


def test_edit_is_refused_while_in_review(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    client.post(f"/instruction-sets/{set_id}/submit", headers=headers("expert"))
    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["title"] = "changed"
    response = edit(client, set_id, doc, "late edit", expected_version=1)
    assert response.status_code == 409
    assert response.json()["state"] == "in_review"
