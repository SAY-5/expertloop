"""Small drivers for the API used across tests."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import headers, sample


def ingest(client: TestClient, name: str, required_approvals: int = 1) -> dict[str, Any]:
    response = client.post(
        "/notes",
        json={
            "title": name.removesuffix(".md").replace("_", " "),
            "body": sample(name),
            "required_approvals": required_approvals,
        },
        headers=headers("expert"),
    )
    assert response.status_code == 201, response.text
    return response.json()


def submit(client: TestClient, set_id: int) -> dict[str, Any]:
    response = client.post(f"/instruction-sets/{set_id}/submit", headers=headers("expert"))
    assert response.status_code == 200, response.text
    return response.json()


def approve(client: TestClient, set_id: int, reviewer: str = "reviewer") -> dict[str, Any]:
    response = client.post(
        f"/instruction-sets/{set_id}/review",
        json={"decision": "approve", "comment": "looks right"},
        headers=headers(reviewer),
    )
    assert response.status_code == 200, response.text
    return response.json()


def add_case(
    client: TestClient, set_id: int, name: str, scenario: dict, expectations: dict
) -> dict[str, Any]:
    response = client.post(
        f"/instruction-sets/{set_id}/test-cases",
        json={"name": name, "scenario": scenario, "expectations": expectations},
        headers=headers("reviewer"),
    )
    assert response.status_code == 201, response.text
    return response.json()


def run_tests(client: TestClient, set_id: int) -> dict[str, Any]:
    response = client.post(f"/instruction-sets/{set_id}/run-tests", headers=headers("reviewer"))
    assert response.status_code == 200, response.text
    return response.json()


def get_set(client: TestClient, set_id: int) -> dict[str, Any]:
    response = client.get(f"/instruction-sets/{set_id}", headers=headers("expert"))
    assert response.status_code == 200, response.text
    return response.json()


def edit(
    client: TestClient, set_id: int, document: dict, reason: str, expected_version: int
) -> Any:
    return client.patch(
        f"/instruction-sets/{set_id}",
        json={"expected_version": expected_version, "reason": reason, "document": document},
        headers=headers("expert"),
    )


def approved_and_green(client: TestClient, name: str = "onboarding_checklist.md") -> int:
    """Ingest a sample, add a passing test case, run it, and take it through approval."""
    set_id = ingest(client, name)["instruction_set"]["id"]
    add_case(
        client,
        set_id,
        "happy path",
        {"facts": {}},
        {"required_actions": ["Create the Okta account"], "must_complete": True},
    )
    assert run_tests(client, set_id)["status"] == "passed"
    submit(client, set_id)
    assert approve(client, set_id)["instruction_set"]["state"] == "approved"
    return set_id
