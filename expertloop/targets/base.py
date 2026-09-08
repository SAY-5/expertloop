from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


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
