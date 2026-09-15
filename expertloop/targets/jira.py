"""Jira target: posts a comment with the agent prompt and attaches the full document.

Jira Cloud's REST v3 comment endpoint takes an Atlassian Document Format body rather than a
plain string, so the prompt is wrapped in a minimal ADF document: a paragraph naming the
instruction set and a code block holding the rendered prompt. Delivery has been exercised
against the fake in ``expertloop/fakes/server.py``, which rejects a non-ADF body the way the
real endpoint does, and not against a Jira tenant.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from expertloop.targets.base import DELIVERY_HEADER, DeliveryError, DeliveryReceipt


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

    @staticmethod
    def adf_document(headline: str, prompt: str) -> dict[str, Any]:
        """The smallest Atlassian Document Format body that carries a prompt verbatim."""
        return {
            "type": "doc",
            "version": 1,
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": headline}]},
                {"type": "codeBlock", "content": [{"type": "text", "text": prompt}]},
            ],
        }

    def deliver(self, payload: dict[str, Any]) -> DeliveryReceipt:
        document = payload["document"]
        headline = (
            f"ExpertLoop {payload['action']}: {document['title']} "
            f"(instruction set {payload['instruction_set_id']} v{payload['version']})"
        )
        delivery = {DELIVERY_HEADER: str(payload.get("delivery_id", ""))}
        try:
            comment = self.client.post(
                f"{self.base_url}/rest/api/3/issue/{self.issue_key}/comment",
                json={"body": self.adf_document(headline, document["agent_prompt"])},
                headers={**self._headers(), **delivery},
            )
            if comment.status_code >= 300:
                raise DeliveryError(f"jira comment failed: {comment.status_code} {comment.text}")
            filename = f"instruction-set-{payload['instruction_set_id']}-v{payload['version']}.json"
            attachment = self.client.post(
                f"{self.base_url}/rest/api/3/issue/{self.issue_key}/attachments",
                files={"file": (filename, json.dumps(document, indent=2), "application/json")},
                headers={**self._headers(), **delivery, "X-Atlassian-Token": "no-check"},
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
