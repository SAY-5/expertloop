"""Jira target: posts a comment with the agent prompt and attaches the full document."""

from __future__ import annotations

import json
from typing import Any

import httpx

from expertloop.targets.base import DeliveryError, DeliveryReceipt


class JiraTarget:
    name = "jira"

    def __init__(
        self, base_url: str, issue_key: str, token: str, client: httpx.Client | None = None
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.issue_key = issue_key
        self.token = token
        self.client = client or httpx.Client(timeout=10.0)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def deliver(self, payload: dict[str, Any]) -> DeliveryReceipt:
        document = payload["document"]
        comment_body = (
            f"ExpertLoop {payload['action']}: {document['title']} "
            f"(instruction set {payload['instruction_set_id']} v{payload['version']})\n\n"
            f"{document['agent_prompt']}"
        )
        try:
            comment = self.client.post(
                f"{self.base_url}/rest/api/3/issue/{self.issue_key}/comment",
                json={"body": comment_body},
                headers=self._headers(),
            )
            if comment.status_code >= 300:
                raise DeliveryError(f"jira comment failed: {comment.status_code} {comment.text}")
            filename = f"instruction-set-{payload['instruction_set_id']}-v{payload['version']}.json"
            attachment = self.client.post(
                f"{self.base_url}/rest/api/3/issue/{self.issue_key}/attachments",
                files={"file": (filename, json.dumps(document, indent=2), "application/json")},
                headers={**self._headers(), "X-Atlassian-Token": "no-check"},
            )
            if attachment.status_code >= 300:
                raise DeliveryError(
                    f"jira attachment failed: {attachment.status_code} {attachment.text}"
                )
        except httpx.HTTPError as exc:
            raise DeliveryError(f"jira unreachable: {exc}") from exc
        return DeliveryReceipt(
            target=self.name,
            status="delivered",
            receipt={
                "issue": self.issue_key,
                "comment": comment.json(),
                "attachment": attachment.json(),
            },
        )
