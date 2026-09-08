"""Deterministic parser for expert task notes.

Notes are markdown or plain text. The parser recognises:

* ``#``/``##`` headings that name a section (steps, preconditions, decision rules,
  tools, expected outcomes, forbidden actions); unknown headings default to steps
* numbered or bulleted items, with indented continuation lines folded into the item
* inline source references: URLs, ``doc:<id>`` identifiers and ticket keys such as ``FIN-2210``

Every item remembers the 1-based line range it came from so the compiler can cite it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

SECTION_ALIASES: dict[str, tuple[str, ...]] = {
    "preconditions": ("precondition", "prerequisite", "before you start", "before starting"),
    "steps": ("step", "procedure", "process", "checklist", "how to", "workflow"),
    "decision_rules": ("decision", "rule", "escalat", "when to", "thresholds"),
    "tools": ("tool", "system", "systems to use"),
    "outcomes": ("outcome", "expected result", "done when", "definition of done", "result"),
    "forbidden": ("never", "do not", "don't", "forbidden", "must not", "prohibited"),
}

ITEM_RE = re.compile(r"^(\s*)(?:(\d+)[.)]|[-*+])\s+(.*)$")
HEADING_RE = re.compile(r"^\s*#{1,6}\s*(.+?)\s*#*\s*$")
URL_RE = re.compile(r"https?://[^\s)\]>\"']+")
DOC_RE = re.compile(r"\bdoc:([A-Za-z0-9_./-]+)")
TICKET_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b")


@dataclass
class SourceRef:
    kind: str  # url | doc | ticket
    ref: str


@dataclass
class NoteItem:
    text: str
    line_start: int
    line_end: int
    section: str
    sources: list[SourceRef] = field(default_factory=list)


@dataclass
class ParsedNote:
    title: str | None
    items: list[NoteItem]
    sources: list[SourceRef]
    line_count: int

    def section(self, name: str) -> list[NoteItem]:
        return [item for item in self.items if item.section == name]


def classify_heading(text: str) -> str:
    lowered = text.lower()
    for section, needles in SECTION_ALIASES.items():
        if any(needle in lowered for needle in needles):
            return section
    return "steps"


def extract_sources(text: str) -> list[SourceRef]:
    refs: list[SourceRef] = []
    seen: set[tuple[str, str]] = set()

    def add(kind: str, ref: str) -> None:
        key = (kind, ref)
        if key not in seen:
            seen.add(key)
            refs.append(SourceRef(kind=kind, ref=ref))

    for match in URL_RE.finditer(text):
        add("url", match.group(0).rstrip(".,;"))
    scrubbed = URL_RE.sub(" ", text)
    for match in DOC_RE.finditer(scrubbed):
        add("doc", match.group(1).rstrip(".,;:"))
    scrubbed = DOC_RE.sub(" ", scrubbed)
    for match in TICKET_RE.finditer(scrubbed):
        add("ticket", match.group(1))
    return refs


def parse_note(body: str) -> ParsedNote:
    lines = body.splitlines()
    title: str | None = None
    items: list[NoteItem] = []
    current_section = "steps"
    open_item: NoteItem | None = None
    open_indent = 0

    def close() -> None:
        nonlocal open_item
        if open_item is not None:
            open_item.text = open_item.text.strip()
            open_item.sources = extract_sources(open_item.text)
            items.append(open_item)
            open_item = None

    for number, raw in enumerate(lines, start=1):
        heading = HEADING_RE.match(raw)
        if heading:
            close()
            if title is None and raw.lstrip().startswith("# "):
                title = heading.group(1)
                continue
            current_section = classify_heading(heading.group(1))
            continue

        item = ITEM_RE.match(raw)
        if item:
            indent = len(item.group(1).expandtabs(4))
            if open_item is not None and indent > open_indent:
                # nested bullet belongs to the open item
                open_item.text += "\n" + item.group(3).strip()
                open_item.line_end = number
                continue
            close()
            open_item = NoteItem(
                text=item.group(3), line_start=number, line_end=number, section=current_section
            )
            open_indent = indent
            continue

        if raw.strip() == "":
            close()
            continue

        if open_item is not None:
            open_item.text += "\n" + raw.strip()
            open_item.line_end = number
            continue

        # a bare paragraph line is treated as one item of the current section
        open_item = NoteItem(
            text=raw.strip(), line_start=number, line_end=number, section=current_section
        )
        open_indent = 0

    close()
    all_sources: list[SourceRef] = []
    seen: set[tuple[str, str]] = set()
    for item in items:
        for ref in item.sources:
            if (ref.kind, ref.ref) not in seen:
                seen.add((ref.kind, ref.ref))
                all_sources.append(ref)
    return ParsedNote(title=title, items=items, sources=all_sources, line_count=len(lines))
