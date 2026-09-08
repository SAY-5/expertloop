from tests.conftest import headers, sample
from tests.helpers import approved_and_green, ingest, run_tests


def test_missing_or_invalid_key(client):
    assert client.get("/instruction-sets").status_code == 401
    assert client.get("/instruction-sets", headers={"X-API-Key": "nope"}).status_code == 401


def test_role_scopes(client):
    note = {"title": "t", "body": sample("onboarding_checklist.md")}
    assert client.post("/notes", json=note, headers=headers("reviewer")).status_code == 403
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    assert (
        client.post(f"/instruction-sets/{set_id}/publish", headers=headers("expert")).status_code
        == 403
    )
    assert (
        client.post(f"/instruction-sets/{set_id}/publish", headers=headers("reviewer")).status_code
        == 403
    )
    assert (
        client.post(f"/instruction-sets/{set_id}/rollback", headers=headers("reviewer")).status_code
        == 403
    )
    assert (
        client.post(
            f"/instruction-sets/{set_id}/review",
            json={"decision": "approve"},
            headers=headers("expert"),
        ).status_code
        == 403
    )
    assert client.post("/notes", json=note, headers=headers("admin")).status_code == 201
    assert client.get(f"/instruction-sets/{set_id}", headers=headers("admin")).status_code == 200


def test_source_hash_verification(client):
    created = client.post(
        "/sources",
        json={
            "kind": "doc",
            "ref": "policy/refunds-v4",
            "title": "Refund policy v4",
            "content": "Refunds above 500 need manager approval.",
        },
        headers=headers("expert"),
    )
    assert created.status_code == 201
    original_hash = created.json()["content_hash"]
    set_id = ingest(client, "refund_handling_sop.md")["instruction_set"]["id"]
    report = client.get(f"/instruction-sets/{set_id}/citations", headers=headers("reviewer")).json()
    linked = [c for c in report["citations"] if c.get("source_ref") == "policy/refunds-v4"]
    assert linked and all(c["source_hash"] == original_hash and c["verified"] for c in linked)

    client.post(
        "/sources",
        json={
            "kind": "doc",
            "ref": "policy/refunds-v4",
            "content": "Refunds above 250 need manager approval.",
        },
        headers=headers("expert"),
    )
    report = client.get(f"/instruction-sets/{set_id}/citations", headers=headers("reviewer")).json()
    assert report["unverified"] == 2
    assert all(
        not c["verified"] for c in report["citations"] if c.get("source_ref") == "policy/refunds-v4"
    )
    sources = client.get("/sources", headers=headers("reviewer")).json()
    assert [s["ref"] for s in sources] == ["policy/refunds-v4", "FIN-2210"]


def test_metrics_and_health(client):
    assert client.get("/healthz").json()["status"] == "ok"
    set_id = approved_and_green(client)
    client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    ingest(client, "incident_triage_note.md")
    run_tests(client, set_id)
    body = client.get("/metrics").text
    assert 'expertloop_instruction_sets{state="published"} 1.0' in body
    assert 'expertloop_instruction_sets{state="draft"} 1.0' in body
    assert "expertloop_test_pass_rate 1.0" in body
    assert 'expertloop_publishes_total{result="delivered"} 1.0' in body
    assert 'expertloop_test_runs_total{status="passed"} 2.0' in body
