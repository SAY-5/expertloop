from typing import Any

import pytest

from expertloop.executor import Registry, evaluate_condition, registry
from tests.conftest import headers
from tests.helpers import add_case, approve, approved_and_green, get_set, ingest, run_tests, submit


class WeekendPlugin:
    name = "weekend"

    def evaluate(self, condition: str, scenario: dict[str, Any]) -> bool | None:
        if "weekend" not in condition:
            return None
        return scenario.get("facts", {}).get("weekday") in ("sat", "sun")


def test_plugins_are_consulted_in_order_and_can_be_removed():
    assert registry.names() == ["flags", "membership", "compare"]
    assert not evaluate_condition("it is the weekend", {"facts": {"weekday": "sun"}})
    # "it is the weekend" also parses as the comparison "it is <the weekend>", so a plugin
    # with its own grammar goes in front of the built-ins
    registry.register(WeekendPlugin(), first=True)
    try:
        assert registry.names()[0] == "weekend"
        assert evaluate_condition("It is the weekend.", {"facts": {"weekday": "sun"}})
        assert not evaluate_condition("it is the weekend", {"facts": {"weekday": "tue"}})
        assert registry.evaluate("it is the weekend", {"facts": {"weekday": "sat"}}) == (
            True,
            "weekend",
        )
        assert registry.evaluate("amount is over 5", {"facts": {"amount": 9}}) == (True, "compare")
        assert registry.evaluate("nothing matches", {}) == (False, None)
        with pytest.raises(ValueError):
            registry.register(WeekendPlugin())
    finally:
        registry.unregister("weekend")
    assert registry.names() == ["flags", "membership", "compare"]
    with pytest.raises(KeyError):
        registry.unregister("weekend")
    with pytest.raises(TypeError):
        Registry().register(object())  # type: ignore[arg-type]

    own = Registry()
    own.register(WeekendPlugin())
    assert own.evaluate("amount is over 5", {"facts": {"amount": 9}}) == (False, None)


def test_builtin_membership_and_flag_plugins():
    assert evaluate_condition("role is one of admin, owner", {"facts": {"role": "Owner"}})
    assert not evaluate_condition("role is one of admin, owner", {"facts": {"role": "guest"}})
    assert evaluate_condition("region in (eu, uk)", {"facts": {"region": "uk"}})
    assert evaluate_condition("tier is one of 1 or 2", {"facts": {"tier": 2}})
    assert not evaluate_condition("region in (eu, uk)", {"facts": {}})
    assert evaluate_condition("customer asked in writing", {"flags": ["Customer asked in writing"]})


def test_coverage_report_counts_steps_and_rules(client):
    set_id = ingest(client, "onboarding_checklist.md")["instruction_set"]["id"]
    empty = client.get(f"/instruction-sets/{set_id}/coverage", headers=headers("reviewer")).json()
    assert (empty["test_cases"], empty["steps"]["covered"], empty["steps"]["total"]) == (0, 0, 6)
    assert empty["decision_rules"]["total"] == 2
    assert [r["id"] for r in empty["decision_rules"]["uncovered"]] == ["global:0", "s3:0"]

    add_case(client, set_id, "employee", {"facts": {"role": "employee"}}, {"must_complete": True})
    report = client.get(f"/instruction-sets/{set_id}/coverage", headers=headers("reviewer")).json()
    assert report["steps"]["coverage"] == 1.0 and report["steps"]["uncovered"] == []
    assert report["decision_rules"]["covered"] == 0

    add_case(
        client,
        set_id,
        "contractor",
        {"facts": {"role": "contractor"}},
        {"required_actions": ["outside collaborator"]},
    )
    add_case(
        client,
        set_id,
        "far start date",
        {"facts": {"start_date": 10}},
        {"must_halt": True},
    )
    report = client.get(f"/instruction-sets/{set_id}/coverage", headers=headers("reviewer")).json()
    assert report["test_cases"] == 3 and report["halting_cases"] == 1
    assert report["decision_rules"] == {
        "total": 2,
        "covered": 2,
        "uncovered": [],
        "coverage": 1.0,
        "hits": {"global:0": 1, "s3:0": 1},
    }
    assert report["steps"]["hits"] == {"s1": 2, "s2": 2, "s3": 2, "s4": 2, "s5": 2, "s6": 2}

    run = run_tests(client, set_id)
    assert run["status"] == "passed"
    assert run["coverage"] == {
        "test_cases": 3,
        "steps": 1.0,
        "steps_uncovered": [],
        "decision_rules": 1.0,
        "decision_rules_uncovered": [],
    }
    assert run["results"][1]["trace"]["rules_fired_ids"] == ["s3:0"]
    assert run["results"][2]["trace"]["steps_executed"] == []


def test_ops_overview_aggregates_state_coverage_drift_and_publishes(client):
    published = approved_and_green(client)
    assert (
        client.post(f"/instruction-sets/{published}/publish", headers=headers("admin")).status_code
        == 200
    )
    blocked = ingest(client, "refund_handling_sop.md")["instruction_set"]["id"]
    add_case(
        client,
        blocked,
        "fraud escalates",
        {"facts": {"reason": "fraud"}},
        {"required_actions": ["risk team"], "must_halt": True},
    )
    run_tests(client, blocked)
    submit(client, blocked)
    approve(client, blocked)
    links = client.post(
        "/sources",
        json={"kind": "doc", "ref": "onboarding/week-one", "content": "changed"},
        headers=headers("expert"),
    ).json()
    client.post(
        f"/sources/{links['id']}/rehash",
        json={"content": "changed again"},
        headers=headers("expert"),
    )
    assert (
        client.post(f"/instruction-sets/{published}/publish", headers=headers("admin")).status_code
        == 409
    )
    waiting = ingest(client, "incident_triage_note.md", review_policy={"review_deadline_hours": 0})[
        "instruction_set"
    ]["id"]
    submit(client, waiting)
    client.post("/reviews/escalate", headers=headers("reviewer"))
    branch = client.post(
        f"/instruction-sets/{published}/branch", json={}, headers=headers("expert")
    )
    assert branch.status_code == 201

    assert client.get("/ops/overview").status_code == 401
    overview = client.get("/ops/overview", headers=headers("reviewer")).json()
    assert overview["instruction_sets"] == {
        "total": 4,
        "branches": 1,
        "by_state": {
            "draft": 1,
            "in_review": 1,
            "changes_requested": 0,
            "approved": 1,
            "published": 1,
            "retired": 0,
        },
    }
    assert overview["coverage"]["sets_with_runs"] == 2
    assert overview["coverage"]["runs_on_current_version"] == 2
    # the fraud case halts on the s2 rule before s2 runs, so the refund set covers 1 of 5
    assert overview["coverage"]["average_step_coverage"] == round((1.0 + 1 / 5) / 2, 3)
    assert overview["coverage"]["lowest"][0]["instruction_set_id"] == blocked
    assert overview["coverage"]["lowest"][0]["uncovered_steps"] == ["s2", "s3", "s4", "s5"]
    assert overview["drift"] == {"open_flags": 1, "stale_sets": [published]}
    assert overview["reviews"] == {"in_review": 1, "overdue": 1, "escalated": 1}
    assert overview["publish"] == {
        "delivered": 2,
        "failed": 0,
        "blocked": 1,
        "rollbacks": 0,
        "published_sets": 1,
    }
    assert overview["executor_plugins"] == ["flags", "membership", "compare"]
    assert client.get("/ops/plugins", headers=headers("expert")).json()["condition_plugins"] == [
        "flags",
        "membership",
        "compare",
    ]
    assert get_set(client, published)["state"] == "published"


def test_a_bare_english_in_is_not_a_membership_operator():
    # "logged in user is admin" used to parse as membership in the list "user is admin" and
    # answer False; the membership operator now has to be spelled out
    assert registry.evaluate("logged in user is admin", {"facts": {"logged_in_user": "admin"}}) == (
        True,
        "compare",
    )
    assert registry.evaluate("logged in user is admin", {"facts": {"logged_in_user": "guest"}}) == (
        False,
        "compare",
    )
    assert evaluate_condition("region is in eu, uk", {"facts": {"region": "eu"}})
    assert registry.evaluate("role is one of admin, owner", {"facts": {"role": "owner"}}) == (
        True,
        "membership",
    )
