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
    last_checked_at: datetime | None
    created_at: datetime


class ReviewPolicyIn(BaseModel):
    required_roles: list[str] = Field(default_factory=list)
    allow_self_approval: bool = False
    review_deadline_hours: float | None = Field(default=None, ge=0)


class PolicyIn(BaseModel):
    review_policy: ReviewPolicyIn
    required_approvals: int | None = Field(default=None, ge=1)


class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=256)
    body: str = Field(min_length=1)
    required_approvals: int | None = Field(default=None, ge=1)
    review_policy: ReviewPolicyIn | None = None


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
    review_policy: dict[str, Any]
    submitted_at: datetime | None
    review_deadline_at: datetime | None
    escalated_at: datetime | None
    parent_id: int | None
    branched_from_version: int | None
    merged_at: datetime | None
    merged_into_version: int | None
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
    review_policy: dict[str, Any]
    review_deadline_at: datetime | None
    escalated_at: datetime | None
    parent_id: int | None
    branched_from_version: int | None
    merged_at: datetime | None
    merged_into_version: int | None


class IngestOut(BaseModel):
    note: NoteOut
    instruction_set: InstructionSetOut
    coverage: CitationCoverage
    sources_linked: int


class EditIn(BaseModel):
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=1)
    document: dict[str, Any]
    # an edit may not invent provenance: citing a source the registry does not hold is a 422
    # unless the editor asks for it to be registered as part of the edit
    register_unknown_sources: bool = False


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
    coverage: dict[str, Any]
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
    missing_roles: list[str] = Field(default_factory=list)


class ReviewerWorkload(BaseModel):
    name: str
    role: str
    pending: list[int]
    overdue: int
    decided: int


class QueueEntry(BaseModel):
    instruction_set_id: int
    name: str
    version: int
    review_round: int
    submitted_at: datetime | None
    review_deadline_at: datetime | None
    overdue: bool
    escalated: bool
    approvals: int
    required_approvals: int
    missing_roles: list[str]
    waiting_on: list[str]


class WorkloadOut(BaseModel):
    generated_at: datetime
    queue: list[QueueEntry]
    reviewers: list[ReviewerWorkload]


class EscalationOut(BaseModel):
    escalated: list[InstructionSetSummary]


class RehashIn(BaseModel):
    content: str | None = None


class DriftFlagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    instruction_set_id: int
    step_id: str
    source_id: int
    cited_hash: str
    current_hash: str
    detected_by: str
    detected_at: datetime
    resolved_at: datetime | None
    resolved_by: str | None
    resolution: str | None


class RehashOut(BaseModel):
    source: SourceOut
    changed: bool
    flags: list[DriftFlagOut]


class DriftScanOut(BaseModel):
    flags: list[DriftFlagOut]
    instruction_sets_flagged: int


class DriftOut(BaseModel):
    instruction_set_id: int
    stale: bool
    stale_steps: list[str]
    open: int
    resolved: int
    flags: list[DriftFlagOut]


class VerifyIn(BaseModel):
    step_ids: list[str] | None = None


class BranchIn(BaseModel):
    name: str | None = Field(default=None, max_length=256)
    from_version: int | None = Field(default=None, ge=1)


class MergeIn(BaseModel):
    reason: str | None = None
    expected_parent_version: int | None = Field(default=None, ge=1)


class MergeOut(BaseModel):
    instruction_set: InstructionSetSummary
    edit: EditOut
    summary: dict[str, int]
