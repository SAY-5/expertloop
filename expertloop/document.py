"""Typed shape of an instruction set document.

The document is stored as JSONB and edited through the API as a whole, so its shape is the
contract between the compiler, the executor and every editor. The models here make that
contract explicit instead of leaving it to whichever key a caller happens to index:

* a step has an id that fits the ``drift_flags.step_id`` column, an action and at least one
  citation, and its list fields default to empty rather than being absent
* a citation is either a line range in the note the set was compiled from or a reference to
  a source of a known kind, so an empty citation object no longer counts as provenance
* a decision rule always has a condition and a consequence, so the executor cannot be handed
  a rule it has to skip silently

``validate_document`` in the compiler package delegates to :func:`document_problems`, which
returns the same list-of-strings contract the service layer turns into a 422.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

SourceKind = Literal["url", "doc", "ticket"]


def _empty_if_none(value: Any) -> Any:
    """The merge in ``expertloop/versioning.py`` writes every step field from one side or the
    other, so a list can arrive as null where one side never had it; treat that as empty."""
    return [] if value is None else value


@dataclass(frozen=True)
class NoteContext:
    """The note a document was compiled from, used to check line-range citations."""

    note_id: int
    line_count: int

    @classmethod
    def of(cls, note_id: int, body: str) -> NoteContext:
        return cls(note_id=note_id, line_count=len(body.splitlines()))


class Citation(BaseModel):
    """Where a step came from: a line range in the note, a registered source, or both."""

    model_config = ConfigDict(extra="forbid")

    note_id: int | None = None
    line_start: int | None = Field(default=None, ge=1)
    line_end: int | None = Field(default=None, ge=1)
    source_kind: SourceKind | None = None
    source_ref: str | None = Field(default=None, min_length=1, max_length=512)
    source_id: int | None = None
    source_hash: str | None = Field(default=None, max_length=64)

    @property
    def has_lines(self) -> bool:
        return self.line_start is not None and self.line_end is not None

    @property
    def has_source(self) -> bool:
        return self.source_kind is not None and self.source_ref is not None


class Rule(BaseModel):
    """``if condition then consequence``, optionally halting the run."""

    model_config = ConfigDict(extra="forbid")

    condition: str = Field(min_length=1)
    then: str = Field(min_length=1)
    halts: bool = False
    citations: Annotated[list[Citation], BeforeValidator(_empty_if_none)] = Field(
        default_factory=list
    )


class Entry(BaseModel):
    """A cited line in ``preconditions``, ``outcomes`` or ``forbidden_actions``."""

    model_config = ConfigDict(extra="forbid")

    text: str
    citations: Annotated[list[Citation], BeforeValidator(_empty_if_none)] = Field(
        default_factory=list
    )


class Step(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # empty rather than required so that "step without id" stays a readable problem
    id: str = Field(default="", max_length=32)
    order: int = 0
    action: str = ""
    condition: str | None = None
    halts: bool = False
    tool: str | None = None
    decision_rules: Annotated[list[Rule], BeforeValidator(_empty_if_none)] = Field(
        default_factory=list
    )
    forbidden: Annotated[list[str], BeforeValidator(_empty_if_none)] = Field(default_factory=list)
    expected_outcome: str | None = None
    citations: Annotated[list[Citation], BeforeValidator(_empty_if_none)] = Field(
        default_factory=list
    )


class SourceReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: SourceKind
    ref: str = Field(min_length=1, max_length=512)


class InstructionDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    steps: Annotated[list[Step], BeforeValidator(_empty_if_none)]
    preconditions: Annotated[list[Entry], BeforeValidator(_empty_if_none)]
    decision_rules: Annotated[list[Rule], BeforeValidator(_empty_if_none)]
    forbidden_actions: Annotated[list[Entry], BeforeValidator(_empty_if_none)]
    name: str = ""
    tools: Annotated[list[str], BeforeValidator(_empty_if_none)] = Field(default_factory=list)
    outcomes: Annotated[list[Entry], BeforeValidator(_empty_if_none)] = Field(default_factory=list)
    sources: Annotated[list[SourceReference], BeforeValidator(_empty_if_none)] = Field(
        default_factory=list
    )
    agent_prompt: str = ""


def _describe(error: dict[str, Any]) -> str:
    """Render one pydantic error the way the service layer reports problems."""
    location = error.get("loc", ())
    if len(location) == 1 and error.get("type") == "missing":
        return f"missing field: {location[0]}"
    path = ".".join(str(part) for part in location) or "document"
    return f"{path}: {error.get('msg', 'is not valid')}"


def _citation_problems(
    step_id: str, index: int, citation: Citation, note: NoteContext | None
) -> list[str]:
    label = f"step {step_id} citation {index}"
    if not citation.has_lines and not citation.has_source:
        return [f"{label} has neither a note line range nor a source reference"]
    problems: list[str] = []
    if citation.source_ref is not None and citation.source_kind is None:
        problems.append(f"{label} has a source reference without a source kind")
    if citation.source_kind is not None and citation.source_ref is None:
        problems.append(f"{label} has a source kind without a source reference")
    if citation.line_start is not None and citation.line_end is not None:
        start, end = citation.line_start, citation.line_end
        if start > end:
            problems.append(f"{label} cites note lines {start}-{end}, which is not a range")
        elif note is not None and citation.note_id is not None and citation.note_id != note.note_id:
            problems.append(
                f"{label} cites note {citation.note_id}, "
                f"but the set was compiled from note {note.note_id}"
            )
        elif note is not None and end > note.line_count:
            problems.append(
                f"{label} cites note lines {start}-{end}, "
                f"but note {note.note_id} has {note.line_count} lines"
            )
    elif citation.line_start is not None or citation.line_end is not None:
        problems.append(f"{label} gives only one end of its note line range")
    return problems


def document_problems(document: dict[str, Any], note: NoteContext | None = None) -> list[str]:
    """Return a list of problems; an empty list means the document is acceptable.

    ``note`` is the note the instruction set was compiled from. When it is given, every
    line-range citation is checked against that note's id and length, so a citation cannot
    point at a line the expert never wrote.
    """
    try:
        parsed = InstructionDocument.model_validate(document)
    except ValidationError as exc:
        return [_describe(error) for error in exc.errors()]

    problems: list[str] = []
    for step in parsed.steps:
        if not step.id:
            problems.append("step without id")
        if not step.action:
            problems.append(f"step {step.id} has no action")
        if not step.citations:
            problems.append(f"step {step.id} has no citations")
        for index, citation in enumerate(step.citations, start=1):
            problems.extend(_citation_problems(step.id, index, citation, note))
    ids = [step.id for step in parsed.steps]
    if len(ids) != len(set(ids)):
        problems.append("duplicate step ids")
    return problems
