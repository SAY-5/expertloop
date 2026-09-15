"""Condition plugins for the executor.

A plugin answers ``evaluate(condition, scenario)`` with True or False when it understands
the condition and None when it does not, so the registry can fall through to the next
one. The built-ins cover free-text flags, numeric and text comparisons and membership;
deployments register their own (business calendars, customer tiers, feature flags) with
``register`` before the app serves requests, or at any time for a single process.
"""

from __future__ import annotations

import re
from typing import Any, Protocol, runtime_checkable

# "is one of a, b" / "is in a, b" and the bracketed "in (a, b)". A bare English "in" is
# deliberately not a membership operator: "logged in user is admin" is a comparison.
MEMBER_RE = re.compile(
    r"^(?P<field>[a-z_][a-z0-9_ ]*?)\s+is\s+(?:one of|in)\s+(?P<values>.+?)$",
    re.IGNORECASE,
)
MEMBER_IN_LIST_RE = re.compile(
    r"^(?P<field>[a-z_][a-z0-9_ ]*?)\s+in\s*[\(\[](?P<values>.+?)[\)\]]$",
    re.IGNORECASE,
)


@runtime_checkable
class ConditionPlugin(Protocol):
    name: str

    def evaluate(self, condition: str, scenario: dict[str, Any]) -> bool | None: ...


class FlagPlugin:
    """A condition is true when it appears verbatim (case-insensitive) in ``flags``."""

    name = "flags"

    def evaluate(self, condition: str, scenario: dict[str, Any]) -> bool | None:
        flags = {str(f).strip().lower() for f in scenario.get("flags", [])}
        return True if condition in flags else None


class MembershipPlugin:
    """``role is one of admin, owner``, ``region is in eu, uk`` or ``region in (eu, uk)``.

    The operator has to be spelled out. A condition that merely contains the English word
    "in", such as ``logged in user is admin``, is left to the comparison grammar.
    """

    name = "membership"

    def evaluate(self, condition: str, scenario: dict[str, Any]) -> bool | None:
        from expertloop.executor.run import _coerce, _lookup

        match = MEMBER_RE.match(condition) or MEMBER_IN_LIST_RE.match(condition)
        if not match:
            return None
        found, actual = _lookup(scenario.get("facts", {}), match.group("field"))
        if not found:
            return False
        values = [_coerce(v) for v in re.split(r",|\bor\b", match.group("values")) if v.strip()]
        if isinstance(actual, str):
            return actual.lower() in {str(v).lower() for v in values}
        return actual in values


class ComparePlugin:
    """The comparison grammar from the first release (``amount is over 500`` and friends)."""

    name = "compare"

    def evaluate(self, condition: str, scenario: dict[str, Any]) -> bool | None:
        from expertloop.executor.run import compare_condition

        return compare_condition(condition, scenario)


class Registry:
    def __init__(self) -> None:
        self._plugins: list[ConditionPlugin] = []

    def register(self, plugin: ConditionPlugin, *, first: bool = False) -> None:
        if not isinstance(plugin, ConditionPlugin):
            raise TypeError("a condition plugin needs a name and an evaluate(condition, scenario)")
        if any(p.name == plugin.name for p in self._plugins):
            raise ValueError(f"condition plugin {plugin.name!r} is already registered")
        if first:
            self._plugins.insert(0, plugin)
        else:
            self._plugins.append(plugin)

    def unregister(self, name: str) -> None:
        before = len(self._plugins)
        self._plugins = [p for p in self._plugins if p.name != name]
        if len(self._plugins) == before:
            raise KeyError(name)

    def names(self) -> list[str]:
        return [p.name for p in self._plugins]

    def evaluate(self, condition: str, scenario: dict[str, Any]) -> tuple[bool, str | None]:
        """Return (result, name of the plugin that answered)."""
        normalized = condition.strip().lower().rstrip(".")
        for plugin in self._plugins:
            answer = plugin.evaluate(normalized, scenario)
            if answer is not None:
                return bool(answer), plugin.name
        return False, None


registry = Registry()
for _builtin in (FlagPlugin(), MembershipPlugin(), ComparePlugin()):
    registry.register(_builtin)
