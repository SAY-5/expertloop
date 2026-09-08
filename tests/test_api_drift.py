import copy

from expertloop import db
from expertloop.drift import DriftScheduler
from expertloop.sources import register_source
from tests.conftest import headers
from tests.helpers import approved_and_green, edit, get_set, ingest


def register(client, kind, ref, content):
    response = client.post(
        "/sources", json={"kind": kind, "ref": ref, "content": content}, headers=headers("expert")
    )
    assert response.status_code == 201, response.text
    return response.json()


def rehash(client, source_id, content):
    response = client.post(
        f"/sources/{source_id}/rehash", json={"content": content}, headers=headers("reviewer")
    )
    assert response.status_code == 200, response.text
    return response.json()


def drift(client, set_id):
    response = client.get(f"/instruction-sets/{set_id}/drift", headers=headers("reviewer"))
    assert response.status_code == 200, response.text
    return response.json()


def test_changed_source_flags_exactly_the_citing_steps(client):
    policy = register(client, "doc", "policy/refunds-v4", "refunds within 30 days")
    template = register(client, "ticket", "FIN-2210", "reply template v1")
    set_id = ingest(client, "refund_handling_sop.md")["instruction_set"]["id"]
    assert drift(client, set_id)["stale"] is False

    unchanged = rehash(client, policy["id"], "refunds within 30 days")
    assert unchanged["changed"] is False and unchanged["flags"] == []
    assert unchanged["source"]["last_checked_at"] is not None

    changed = rehash(client, policy["id"], "refunds within 14 days")
    assert changed["changed"] is True
    assert [f["step_id"] for f in changed["flags"]] == ["s2"]
    assert changed["flags"][0]["cited_hash"] == policy["content_hash"]
    assert changed["flags"][0]["current_hash"] == changed["source"]["content_hash"]

    report = drift(client, set_id)
    assert (report["stale"], report["stale_steps"], report["open"]) == (True, ["s2"], 1)

    # a second scan does not duplicate the open flag, but a change to the other source adds s5
    assert client.post("/sources/check-drift", headers=headers("expert")).json()["flags"] == []
    register(client, "ticket", "FIN-2210", "reply template v2")
    assert drift(client, set_id)["stale_steps"] == ["s2", "s5"]
    assert (
        template["content_hash"]
        != client.get("/sources", headers=headers("expert")).json()[1]["content_hash"]
    )
    audit = client.get(f"/instruction-sets/{set_id}/audit", headers=headers("reviewer")).json()
    assert [a["detail"]["steps"] for a in audit if a["action"] == "drift_detected"] == [
        ["s2"],
        ["s5"],
    ]


def test_stale_set_blocks_publish_until_reverified(client):
    links = register(client, "doc", "onboarding/week-one", "handbook, wiki")
    set_id = approved_and_green(client)
    assert [
        f["step_id"] for f in rehash(client, links["id"], "handbook, wiki, primer")["flags"]
    ] == ["s6"]

    blocked = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert blocked.status_code == 409 and blocked.json()["stale_steps"] == ["s6"]
    assert get_set(client, set_id)["state"] == "approved"

    forbidden = client.post(
        f"/instruction-sets/{set_id}/drift/verify", json={}, headers=headers("reviewer")
    )
    assert forbidden.status_code == 403
    verified = client.post(
        f"/instruction-sets/{set_id}/drift/verify",
        json={"step_ids": ["s6"]},
        headers=headers("expert"),
    )
    assert verified.status_code == 200, verified.text
    assert [(f["step_id"], f["resolution"], f["resolved_by"]) for f in verified.json()] == [
        ("s6", "reverified", "dana")
    ]
    report = drift(client, set_id)
    assert (report["stale"], report["open"], report["resolved"]) == (False, 0, 1)
    again = client.post(
        f"/instruction-sets/{set_id}/drift/verify", json={}, headers=headers("expert")
    )
    assert again.status_code == 409

    # a re-verified hash is not flagged again, but a further change is
    assert client.post("/sources/check-drift", headers=headers("expert")).json()["flags"] == []
    assert rehash(client, links["id"], "handbook only")["flags"][0]["step_id"] == "s6"
    assert drift(client, set_id)["stale"] is True
    client.post(f"/instruction-sets/{set_id}/drift/verify", json={}, headers=headers("expert"))
    published = client.post(f"/instruction-sets/{set_id}/publish", headers=headers("admin"))
    assert published.status_code == 200, published.text


def test_editing_the_stale_step_resolves_it_and_scheduler_scans(client):
    links = register(client, "doc", "onboarding/week-one", "handbook, wiki")
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    rehash(client, links["id"], "handbook, wiki, primer")

    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][0]["action"] += " (unrelated)"
    assert edit(client, set_id, doc, "touch s1", expected_version=1).status_code == 200
    assert drift(client, set_id)["stale_steps"] == ["s6"], "editing s1 leaves s6 stale"

    doc = copy.deepcopy(get_set(client, set_id)["document"])
    doc["steps"][5]["action"] += " including the on-call primer"
    assert edit(client, set_id, doc, "add primer link", expected_version=2).status_code == 200
    report = drift(client, set_id)
    assert report["stale"] is False and report["flags"][0]["resolution"] == "edited"
    assert (
        get_set(client, set_id)["document"]["steps"][5]["citations"][1]["source_hash"]
        == (report["flags"][0]["current_hash"])
    )
    audit = client.get(f"/instruction-sets/{set_id}/audit", headers=headers("reviewer")).json()
    assert [a["detail"].get("drift_resolved") for a in audit if a["action"] == "edit"] == [
        [],
        ["s6"],
    ]

    # the scheduler picks up a hash that changed without going through the API
    with db.session_factory()() as session:
        register_source(session, "doc", "onboarding/week-one", "handbook")
        session.commit()
    scheduler = DriftScheduler(db.session_factory(), interval=0)
    assert scheduler.tick() == 1 and scheduler.runs == 1
    assert scheduler.tick() == 0
    assert drift(client, set_id)["stale_steps"] == ["s6"]
    assert client.app.state.drift_scheduler.runs == 0, "the app scheduler is off by default"
