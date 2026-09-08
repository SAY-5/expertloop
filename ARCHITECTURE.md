# Architecture

ExpertLoop is a FastAPI service backed by PostgreSQL. It has four stages, and every
stage writes rows that the next stage can be audited against.

```
expert note ──> compiler ──> instruction set (v1) ──> edits / review ──> approved
                  │                │                                        │
                  └─ citations ────┘                              test cases + executor
                                                                            │
                                                              green run on current version
                                                                            │
                                                           publish ──> webhook + Jira targets
                                                                            │
                                                                     receipts, rollback
```

## Compiler and citations

`expertloop/compiler/parser.py` turns a markdown or plain-text note into items. Headings
are classified into sections (`preconditions`, `steps`, `decision_rules`, `tools`,
`outcomes`, `forbidden`) by keyword; unknown headings default to `steps`. Numbered and
bulleted items are folded together with their indented continuation lines, and each item
keeps its 1-based line range. Inline references are extracted in a fixed order: URLs,
`doc:<id>` identifiers, then ticket keys such as `FIN-2210`.

`expertloop/compiler/compile.py` produces a plain dictionary (stored as JSONB) with
`preconditions`, `steps`, `decision_rules`, `tools`, `outcomes`, `forbidden_actions`,
`sources` and a rendered `agent_prompt`. Per step it derives:

* `action`: the text the agent performs
* `condition`: set when the step itself is `if X, Y`; the step runs only when X holds
* `decision_rules`: `if X then Y` lines inside the step, with `halts` when Y contains a
  stop word (`stop`, `escalate`, `halt`, `do not proceed`, `hand off`, `pause`)
* `forbidden`: `never` / `do not` / `must not` clauses
* `expected_outcome`: text after `so that`, `until`, `expected:` or `result:`
* `tool`: the first known tool mentioned, or a capitalised name after `in`, `via`, `open`, `call`
* `citations`: always the note line range, plus one citation per source reference on the item

Citations are the contract: `validate_document` rejects any document with a step that has
no citation, both at ingest and on every edit, so coverage is 100% by construction. The
compiler is deterministic; there is no model call in the default path. A rewriting model
can be layered on top as an optional edit author, but it never bypasses validation.

`expertloop/sources/registry.py` stores each referenced source with a SHA-256 of its
content (or of the reference itself when no content was supplied). `resolve_citations`
attaches `source_id` and `source_hash` to every citation; `verify_citations` compares
stored hashes with the registry's current hash. When a policy document is re-registered
with new content, `GET /instruction-sets/{id}/citations` reports those citations as
unverified instead of silently pointing at changed text.

## Source drift

`expertloop/drift.py` re-hashes a source (`rehash_source`) and compares each step's cited
`source_hash` with the registry's current hash (`scan_drift`). A mismatch creates a
`drift_flags` row per step and source and an audit event `drift_detected`; open flags
make the set stale and `_publish_gate` refuses to publish it. A flag is resolved when an
expert re-verifies the step (`POST /instruction-sets/{id}/drift/verify`) or edits it: an
edit refreshes citation hashes only on steps that changed, so touching an unrelated step
does not clear the flag. A step re-verified against a hash is not flagged again for that
hash, but a further change to the source flags it anew. `DriftScheduler` runs the same
scan on a background thread when `drift_check_interval_seconds` is set.

## Edits and optimistic concurrency

An edit (`PATCH /instruction-sets/{id}`) sends the full document, a reason and
`expected_version`. The service rejects the edit with 409 when the stored version differs,
with 422 when validation fails, and with 409 when the document is unchanged. A successful
edit writes an `edits` row (author, from/to version, reason, unified diff of the canonical
JSON), an `instruction_set_versions` snapshot, and bumps `instruction_sets.version`.
Snapshots are what publication and rollback deliver, so a rollback never depends on the
current head.

## Approval state machine

```
draft ──submit──> in_review ──approve──> approved ──publish──> published ──retire──> retired
  ^                  │  ^                    │                     │
  │   request_changes│  │resubmit            │edit                 │edit (revise)
  │                  v  │                    v                     v
  └───────── changes_requested             draft                 draft
```

`expertloop/workflow/state.py` holds the transition table; `assert_transition` raises
`IllegalTransition` (HTTP 409) for anything else. Reviews are recorded per version and per
review round (`review_round` increments on submit and resubmit), so approvals for an older
version or an earlier round never count. `required_approvals` is set per instruction set;
distinct reviewers are counted, and roles are enforced by API key (`expert`, `reviewer`,
`admin`). Every transition, edit, review, test run, blocked publish and delivery writes
an `audit_events` row.

`expertloop/reviews.py` adds the per-set review policy (`review_policy` JSON). Approval
needs `required_approvals` distinct approvers and at least one approver per role in
`required_roles`; the response and the `approval_recorded` audit event name the roles
still missing. Unless `allow_self_approval` is set, neither the note author nor the
author of the current version (the last editor) may approve it. `submit` and `resubmit`
start the review clock: `review_deadline_at` is `submitted_at` plus
`review_deadline_hours`. `escalate_overdue` writes one `review_escalated` event per
overdue set and stamps `escalated_at`; a resubmit clears it. `workload` builds the
review queue (sorted by deadline) and, per reviewer, the sets still waiting on them.

## Test gating

Test cases (`test_cases`) pair a scenario (`facts` and `flags`) with expectations:
`required_actions`, `forbidden_actions`, `expected_outcomes`, `expected_tools`,
`must_halt`, `must_complete`. `POST /instruction-sets/{id}/run-tests` executes every case
with `expertloop/executor/run.py`, a deterministic rule-following stand-in for the agent:
it evaluates global rules, skips conditional steps whose condition is false, fires
per-step decision rules (halting when a rule says so), records actions, tool calls and
outcomes, and stops at halting steps. The run is stored with per-case failures and the
version it covered.

Publication requires state `approved` and a latest test run that is green for the current
version. Anything else is a 409 that names the failing cases (or the stale version), is
counted in `expertloop_publishes_total{result="blocked"}` and audited as
`publish_blocked`. An edit after approval moves the set back to `draft`, so a fix always
goes through review and a fresh run before it can reach a business system.

## Publish and rollback

`expertloop/targets/` delivers the version snapshot to every configured target and stores
one `publications` row per target with the receipt returned by the system:

* `WebhookTarget` posts canonical JSON with `X-ExpertLoop-Timestamp` and an HMAC-SHA256
  `X-ExpertLoop-Signature` over `<timestamp>.<body>`
* `JiraTarget` adds a comment containing the agent prompt and attaches the document as JSON

If any target fails, the failure is recorded, the set stays `approved`, and the call
returns 409 listing the failed targets. On success the set becomes `published` and
`published_version` is set. Rollback re-delivers the most recent earlier delivered
version from its snapshot, records `rollback` publications and moves `published_version`
back; the head keeps its state so the faulty revision can be fixed and re-published.

`expertloop/fakes/server.py` is a small FastAPI app that verifies webhook signatures and
mimics the Jira comment and attachment endpoints; the compose stack and the test suite use
it as the business system.

## Observability

`/metrics` exposes instruction sets by state, cumulative test pass rate, test runs by
status, publishes by result (delivered, blocked, failed) and rollbacks. Requests are logged
as JSON through structlog.
