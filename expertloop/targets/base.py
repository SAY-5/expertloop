from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# carries the payload's stable delivery_id so a receiver can recognise a re-posted delivery
DELIVERY_HEADER = "X-ExpertLoop-Delivery"


class DeliveryError(Exception):
    pass


@dataclass
class DeliveryReceipt:
    target: str
    status: str  # delivered | failed
    receipt: dict[str, Any] = field(default_factory=dict)


class Target(Protocol):
    name: str

    def deliver(self, payload: dict[str, Any]) -> DeliveryReceipt: ...
