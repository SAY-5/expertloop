"""Rule-based compiler from a parsed note to an ``InstructionSet`` document.

The output is a plain dictionary (stored as JSONB) so that edits can be diffed and
versioned without an ORM round trip. Every step carries at least one citation: the
line range of the note item it came from plus any source references found on it.
"""

from __future__ import annotations

import re
from typing import Any

from expertloop.compiler.parser import NoteItem, ParsedNote, SourceRef, parse_note

TOOL_RE = re.compile(r"\b(?:in|via|using|through|open|call|from)\s+([A-Z][A-Za-z0-9]+(?:\s[A-Z][A-Za-z0-9]+)?)")
RULE_RE = re.compile(r"^\s*(?:if|when)\s+(.+?)\s*(?:,|then)\s*(.+)$", re.IGNORECASE)
FORBIDDEN_RE = re.compile(r"\b(?:never|do not|don't|must not)\s+(.+)", re.IGNORECASE)
OUTCOME_RE = re.compile(r"\b(?:so that|until|expected:|result:)\s*(.+)$", re.IGNORECASE)
STOP_WORDS = ("stop", "halt", "escalate", "do not proceed", "hand off", "hand it off", "pause")


def _citation(item: NoteItem, note_id: int | None, ref: SourceRef | None = None) -> dict[str, Any]:
    cite: dict[str, Any] = {
        "note_id": note_id,
        "line_start": item.line_start,
        "line_end": item.line_end,
    }
    if ref is not None:
        cite["source_kind"] = ref.kind
        cite["source_ref"] = ref.ref
    return cite


def _citations(item: NoteItem, note_id: int | None) -> list[dict[str, Any]]:
    cites = [_citation(item, note_id)]
    cites.extend(_citation(item, note_id, ref) for ref in item.sources)
    return cites


def _first_line(text: str) -> str:
    return text.split("\n", 1)[0].strip()


def _detect_tool(text: str, known_tools: list[str]) -> str | None:
    lowered = text.lower()
    for tool in known_tools:
        if tool.lower() in lowered:
            return tool
    match = TOOL_RE.search(text)
    return match.group(1) if match else None


def _split_rules(text: str) -> tuple[str, list[dict[str, str]], list[str], str | None]:
    """Separate a step into its action, embedded decision rules, forbidden clauses, outcome."""
    action_lines: list[str] = []
    rules: list[dict[str, str]] = []
    forbidden: list[str] = []
    outcome: str | None = None
    for line in text.split("\n"):
        rule = RULE_RE.match(line)
        if rule:
            then = rule.group(2).strip().rstrip(".")
            rules.append(
                {
                    "condition": rule.group(1).strip(),
                    "then": then,
                    "halts": any(word in then.lower() for word in STOP_WORDS),
                }
            )
            continue
        banned = FORBIDDEN_RE.search(line)
        if banned:
            forbidden.append(banned.group(1).strip().rstrip("."))
            continue
        result = OUTCOME_RE.search(line)
        if result and outcome is None:
            outcome = result.group(1).strip().rstrip(".")
            line = line[: result.start()].strip().rstrip(",")
            if line:
                action_lines.append(line)
            continue
        action_lines.append(line.strip())
    action = " ".join(part for part in action_lines if part).strip()
    return action, rules, forbidden, outcome


def compile_parsed(parsed: ParsedNote, note_id: int | None, name: str) -> dict[str, Any]:
    tools = [_first_line(item.text).rstrip(".") for item in parsed.section("tools")]
    steps: list[dict[str, Any]] = []
    global_rules: list[dict[str, Any]] = []
    forbidden_actions: list[dict[str, Any]] = []
    preconditions = [
        {"text": _first_line(item.text).rstrip("."), "citations": _citations(item, note_id)}
        for item in parsed.section("preconditions")
    ]
    outcomes = [
        {"text": _first_line(item.text).rstrip("."), "citations": _citations(item, note_id)}
        for item in parsed.section("outcomes")
    ]

    for item in parsed.section("decision_rules"):
        rule = RULE_RE.match(_first_line(item.text))
        if rule:
            then = rule.group(2).strip().rstrip(".")
            global_rules.append(
                {
                    "condition": rule.group(1).strip(),
                    "then": then,
                    "halts": any(word in then.lower() for word in STOP_WORDS),
                    "citations": _citations(item, note_id),
                }
            )
        else:
            global_rules.append(
                {
                    "condition": _first_line(item.text).rstrip("."),
                    "then": "apply rule",
                    "halts": False,
                    "citations": _citations(item, note_id),
                }
            )

    for item in parsed.section("forbidden"):
        banned = FORBIDDEN_RE.search(item.text)
        text = banned.group(1) if banned else _first_line(item.text)
        forbidden_actions.append(
            {"text": text.strip().rstrip("."), "citations": _citations(item, note_id)}
        )

    for index, item in enumerate(parsed.section("steps"), start=1):
        action, rules, banned, outcome = _split_rules(item.text)
        if not action:
            action = _first_line(item.text)
        step = {
            "id": f"s{index}",
            "order": index,
            "action": action.rstrip("."),
            "tool": _detect_tool(item.text, tools),
            "decision_rules": rules,
            "forbidden": banned,
            "expected_outcome": outcome,
            "citations": _citations(item, note_id),
        }
        steps.append(step)
        for text in banned:
            forbidden_actions.append({"text": text, "citations": _citations(item, note_id)})

    document = {
        "name": name,
        "title": parsed.title or name,
        "preconditions": preconditions,
        "steps": steps,
        "decision_rules": global_rules,
        "tools": tools,
        "outcomes": outcomes,
        "forbidden_actions": forbidden_actions,
        "sources": [{"kind": ref.kind, "ref": ref.ref} for ref in parsed.sources],
    }
    document["agent_prompt"] = render_prompt(document)
    return document


def compile_note(body: str, note_id: int | None = None, name: str | None = None) -> dict[str, Any]:
    parsed = parse_note(body)
    return compile_parsed(parsed, note_id, name or parsed.title or "untitled")


def render_prompt(document: dict[str, Any]) -> str:
    """Render the instruction set as the text an agent will receive."""
    lines = [f"# {document['title']}", ""]
    if document["preconditions"]:
        lines.append("Before starting, confirm:")
        lines.extend(f"- {p['text']}" for p in document["preconditions"])
        lines.append("")
    lines.append("Follow these steps in order:")
    for step in document["steps"]:
        tool = f" (tool: {step['tool']})" if step.get("tool") else ""
        lines.append(f"{step['order']}. {step['action']}{tool}")
        for rule in step["decision_rules"]:
            lines.append(f"   - if {rule['condition']}: {rule['then']}")
        if step.get("expected_outcome"):
            lines.append(f"   - expected: {step['expected_outcome']}")
    if document["decision_rules"]:
        lines.append("")
        lines.append("Decision rules:")
        lines.extend(f"- if {r['condition']}: {r['then']}" for r in document["decision_rules"])
    if document["forbidden_actions"]:
        lines.append("")
        lines.append("Never:")
        lines.extend(f"- {f['text']}" for f in document["forbidden_actions"])
    if document["outcomes"]:
        lines.append("")
        lines.append("Done when:")
        lines.extend(f"- {o['text']}" for o in document["outcomes"])
    return "\n".join(lines)


def citation_coverage(document: dict[str, Any]) -> dict[str, Any]:
    steps = document.get("steps", [])
    cited = [s for s in steps if s.get("citations")]
    total = len(steps)
    return {
        "steps": total,
        "cited_steps": len(cited),
        "citations": sum(len(s.get("citations", [])) for s in steps),
        "coverage": (len(cited) / total) if total else 1.0,
    }


def validate_document(document: dict[str, Any]) -> list[str]:
    """Return a list of problems; an empty list means the document is acceptable."""
    problems: list[str] = []
    for key in ("title", "steps", "preconditions", "decision_rules", "forbidden_actions"):
        if key not in document:
            problems.append(f"missing field: {key}")
    for step in document.get("steps", []):
        if not step.get("id"):
            problems.append("step without id")
        if not step.get("action"):
            problems.append(f"step {step.get('id')} has no action")
        if not step.get("citations"):
            problems.append(f"step {step.get('id')} has no citations")
    ids = [s.get("id") for s in document.get("steps", [])]
    if len(ids) != len(set(ids)):
        problems.append("duplicate step ids")
    return problems
