from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from expertloop.models import State


class SourceIn(BaseModel):
    kind: str = Field(pattern="^(url|doc|ticket)$")
    ref: str = Field(min_length=1, max_length=512)
    title: str | None = None
    content: str | None = None


class SourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    ref: str
    title: str | None
    content_hash: str
    created_at: datetime


class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=256)
    body: str = Field(min_length=1)
    required_approvals: int | None = Field(default=None, ge=1)


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    author: str
    body: str
    created_at: datetime


class CitationCoverage(BaseModel):
    steps: int
    cited_steps: int
    citations: int
    coverage: float


class InstructionSetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    note_id: int
    name: str
    state: State
    version: int
    published_version: int | None
    required_approvals: int
    document: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class InstructionSetSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    note_id: int
    name: str
    state: State
    version: int
    published_version: int | None
    required_approvals: int


class IngestOut(BaseModel):
    note: NoteOut
    instruction_set: InstructionSetOut
    coverage: CitationCoverage
    sources_linked: int


class EditIn(BaseModel):
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=1)
    document: dict[str, Any]


class EditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    author: str
    from_version: int
    to_version: int
    reason: str
    diff: str
    created_at: datetime


class ReviewIn(BaseModel):
    decision: str = Field(pattern="^(approve|request_changes)$")
    comment: str = ""


class ReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    reviewer: str
    reviewer_role: str
    version: int
    decision: str
    comment: str
    created_at: datetime


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    actor: str
    action: str
    from_state: str | None
    to_state: str | None
    detail: dict[str, Any]
    created_at: datetime


class TestCaseIn(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    scenario: dict[str, Any] = Field(default_factory=dict)
    expectations: dict[str, Any] = Field(default_factory=dict)


class TestCaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    author: str
    scenario: dict[str, Any]
    expectations: dict[str, Any]
    created_at: datetime


class TestRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    version: int
    triggered_by: str
    status: str
    passed: int
    failed: int
    results: list[dict[str, Any]]
    created_at: datetime


class PublicationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    version: int
    actor: str
    action: str
    target: str
    status: str
    receipt: dict[str, Any]
    created_at: datetime


class PublishOut(BaseModel):
    instruction_set: InstructionSetSummary
    publications: list[PublicationOut]


class TransitionOut(BaseModel):
    instruction_set: InstructionSetSummary
    approvals: int
    required_approvals: int
