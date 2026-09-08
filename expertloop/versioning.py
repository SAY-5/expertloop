"""Structured diff and three-way merge of instruction set documents.

Steps are matched by ``id`` and compared field by field; section entries
(preconditions, decision rules, forbidden actions, outcomes) are matched by their text.
Citation source hashes are ignored when comparing, so a re-hashed source does not show
up as an edit. The merge takes a change made on one side only, keeps identical changes,
and reports a conflict when both sides changed the same field differently.
"""

from __future__ import annotations

import json
from typing import Any

SECTIONS = ("preconditions", "decision_rules", "forbidden_actions", "outcomes")
SCALARS = ("title", "tools")
STEP_FIELDS = (
    "order",
    "action",
    "condition",
    "halts",
    "tool",
    "decision_rules",
    "forbidden",
    "expected_outcome",
    "citations",
)


def _canon(value: Any) -> Any:
    """Copy of ``value`` with citation source hashes dropped, for comparisons."""
    if isinstance(value, dict):
        return {k: _canon(v) for k, v in value.items() if k != "source_hash"}
    if isinstance(value, list):
        return [_canon(v) for v in value]
    return value


def _same(a: Any, b: Any) -> bool:
    return json.dumps(_canon(a), sort_keys=True) == json.dumps(_canon(b), sort_keys=True)


def _entry_key(entry: dict[str, Any]) -> str:
    if "condition" in entry and "then" in entry:
        return f"if {entry['condition']} then {entry['then']}"
    return str(entry.get("text", ""))


def _steps(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {step["id"]: step for step in document.get("steps", [])}


def _entries(document: dict[str, Any], section: str) -> dict[str, dict[str, Any]]:
    return {_entry_key(entry): entry for entry in document.get(section, [])}


def diff_documents(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Step-level diff: added, removed and changed steps plus section entry changes."""
    before, after = _steps(old), _steps(new)
    added = [after[i] for i in after if i not in before]
    removed = [before[i] for i in before if i not in after]
    changed = []
    for step_id in before:
        if step_id not in after:
            continue
        fields = {
            f: {"before": before[step_id].get(f), "after": after[step_id].get(f)}
            for f in STEP_FIELDS
            if not _same(before[step_id].get(f), after[step_id].get(f))
        }
        if fields:
            changed.append({"id": step_id, "fields": fields})
    sections = {}
    for section in SECTIONS:
        old_entries, new_entries = _entries(old, section), _entries(new, section)
        sections[section] = {
            "added": [new_entries[k] for k in new_entries if k not in old_entries],
            "removed": [old_entries[k] for k in old_entries if k not in new_entries],
        }
    scalars = {
        f: {"before": old.get(f), "after": new.get(f)}
        for f in SCALARS
        if not _same(old.get(f), new.get(f))
    }
    return {
        "steps": {"added": added, "removed": removed, "changed": changed},
        "sections": sections,
        "fields": scalars,
        "summary": {
            "steps_added": len(added),
            "steps_removed": len(removed),
            "steps_changed": len(changed),
            "entries_added": sum(len(s["added"]) for s in sections.values()),
            "entries_removed": sum(len(s["removed"]) for s in sections.values()),
            "fields_changed": len(scalars),
        },
    }


def _merge_value(base: Any, ours: Any, theirs: Any) -> tuple[Any, bool]:
    """Return (merged value, conflict)."""
    if _same(ours, base):
        return theirs, False
    if _same(theirs, base) or _same(ours, theirs):
        return ours, False
    return ours, True


def merge_documents(
    base: dict[str, Any], ours: dict[str, Any], theirs: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Three-way merge of ``theirs`` (a branch) into ``ours`` (the parent head).

    Returns the merged document and a list of conflicts; the document is only meaningful
    when the list is empty.
    """
    merged: dict[str, Any] = json.loads(json.dumps(ours))
    conflicts: list[dict[str, Any]] = []

    for field in SCALARS:
        value, conflict = _merge_value(base.get(field), ours.get(field), theirs.get(field))
        merged[field] = value
        if conflict:
            conflicts.append(
                {
                    "kind": "field",
                    "field": field,
                    "base": base.get(field),
                    "parent": ours.get(field),
                    "branch": theirs.get(field),
                }
            )

    b, o, t = _steps(base), _steps(ours), _steps(theirs)
    steps: list[dict[str, Any]] = []
    for step_id in sorted(set(b) | set(o) | set(t)):
        in_base, in_ours, in_theirs = step_id in b, step_id in o, step_id in t
        if not in_ours and not in_theirs:
            continue  # removed on both sides
        if in_ours and in_theirs:
            step = json.loads(json.dumps(o[step_id]))
            for field in STEP_FIELDS:
                base_value = b[step_id].get(field) if in_base else None
                value, conflict = _merge_value(
                    base_value, o[step_id].get(field), t[step_id].get(field)
                )
                step[field] = value
                if conflict:
                    conflicts.append(
                        {
                            "kind": "step",
                            "step_id": step_id,
                            "field": field,
                            "base": base_value,
                            "parent": o[step_id].get(field),
                            "branch": t[step_id].get(field),
                        }
                    )
            steps.append(step)
            continue
        present, side = (o[step_id], "parent") if in_ours else (t[step_id], "branch")
        if not in_base:
            steps.append(present)  # added on one side
        elif _same(present, b[step_id]):
            continue  # removed on the other side, untouched here
        else:
            conflicts.append(
                {
                    "kind": "step",
                    "step_id": step_id,
                    "field": None,
                    "base": b[step_id],
                    "parent": o.get(step_id),
                    "branch": t.get(step_id),
                    "reason": f"removed on one side and changed on the {side}",
                }
            )
    steps.sort(key=lambda s: (s.get("order", 0), s["id"]))
    merged["steps"] = steps

    for section in SECTIONS:
        base_e, our_e, their_e = (
            _entries(base, section),
            _entries(ours, section),
            _entries(theirs, section),
        )
        kept = []
        for key, entry in our_e.items():
            if key in their_e or key not in base_e:
                kept.append(entry)  # still on the branch, or added by the parent
            # else: the branch removed an entry the parent kept unchanged
        kept.extend(
            entry for key, entry in their_e.items() if key not in our_e and key not in base_e
        )
        merged[section] = kept
    return merged, conflicts
