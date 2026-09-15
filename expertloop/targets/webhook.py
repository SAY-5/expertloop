"""Signed webhook target.

The body is canonical JSON and the ``X-ExpertLoop-Signature`` header carries an
HMAC-SHA256 over ``<timestamp>.<body>`` so receivers can verify origin and freshness.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

import httpx

from expertloop.targets.base import DELIVERY_HEADER, DeliveryError, DeliveryReceipt

SIGNATURE_HEADER = "X-ExpertLoop-Signature"
TIMESTAMP_HEADER = "X-ExpertLoop-Timestamp"


def canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sign_payload(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode("utf-8"), f"{timestamp}.".encode() + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def verify_signature(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    return hmac.compare_digest(sign_payload(secret, timestamp, body), signature)


class WebhookTarget:
    name = "webhook"

    def __init__(self, url: str, secret: str, client: httpx.Client | None = None) -> None:
        self.url = url
        self.secret = secret
        self.client = client or httpx.Client(timeout=10.0)

    def deliver(self, payload: dict[str, Any]) -> DeliveryReceipt:
        body = canonical(payload)
        timestamp = str(int(time.time()))
        headers = {
            "Content-Type": "application/json",
            TIMESTAMP_HEADER: timestamp,
            SIGNATURE_HEADER: sign_payload(self.secret, timestamp, body),
            DELIVERY_HEADER: str(payload.get("delivery_id", "")),
        }
        try:
            response = self.client.post(self.url, content=body, headers=headers)
        except httpx.HTTPError as exc:
            raise DeliveryError(f"webhook unreachable: {exc}") from exc
        if response.status_code >= 300:
            raise DeliveryError(
                f"webhook rejected delivery: {response.status_code} {response.text}"
            )
        try:
            receipt = response.json()
        except ValueError:
            receipt = {"raw": response.text}
        return DeliveryReceipt(target=self.name, status="delivered", receipt=receipt)
