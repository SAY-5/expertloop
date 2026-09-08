# ExpertLoop

Turns expert task notes into agent instructions with linked sources, tracks edits and
approval state in PostgreSQL, and gates approved workflows behind test cases before they
reach business systems.

Python 3.12, FastAPI, SQLAlchemy 2, Alembic, PostgreSQL 16, pydantic v2, structlog,
Prometheus metrics.

```
 expert note (markdown)          reviewers               business systems
        │                            │                          ▲
        v                            v                          │
  POST /notes ──> compiler ──> instruction set v1 ──> edits ──> review ──> approved
                     │              │  (JSONB, versioned)          │           │
                     └── citations ─┘  every step cites            │     test cases run by a
                         note lines + registered sources           │     deterministic executor
                                                                   │           │
                                                        blocked <── red    green + approved
                                                                               │
                                                     POST /publish ──> signed webhook + Jira
                                                                       receipts, rollback
```

## What it does

* **Notes ingest.** `POST /notes` takes an expert's markdown or plain-text task notes
  with source references (URLs, `doc:` ids, ticket keys). A deterministic, rule-based
  compiler extracts preconditions, steps, decision rules, tools, expected outcomes and
  forbidden actions into a versioned `InstructionSet`. Every step carries citations back
  to the note's line range and to any referenced source; sources are stored with content
  hashes so a citation can be re-verified later.
* **Edits and approval state in PostgreSQL.** Each edit is a row with author, reason and
  unified diff, guarded by optimistic concurrency (`expected_version`). Review follows
  `draft -> in_review -> changes_requested -> approved -> published -> retired` with
  per-set required approval counts, reviewer roles and a full audit trail.
* **Test cases gate publication.** Test cases pair an input scenario with expectations
  (required actions, forbidden actions, expected outcomes and tools, halt or complete).
  `POST /instruction-sets/{id}/run-tests` executes the set against a local rule-following
  executor and records the run. Publishing needs state `approved` and a green run on the
  current version; a failing case blocks publish and is named in the response.
* **Reach business systems.** `publish` delivers the version snapshot to a signed webhook
  target and a Jira comment plus attachment target, records receipts per target, and
  `rollback` re-delivers the previous published version.
* **Review policies and SLAs.** Each set carries a review policy: required approval
  count, reviewer roles that must be among the approvers, whether the author of the
  current version may approve it (off by default), and a review deadline in hours.
  Submitting starts the clock; `POST /reviews/escalate` (also run by the scheduler)
  writes a `review_escalated` audit event for overdue sets, and `GET /reviews/workload`
  shows the queue with deadlines and what each reviewer still owes.
* **Source drift detection.** Sources are re-hashed on demand (`POST /sources/{id}/rehash`,
  `POST /sources/check-drift`, or re-registering with new content) or on a schedule
  (`EXPERTLOOP_DRIFT_CHECK_INTERVAL_SECONDS`). When a hash changes, every step citing that
  source is flagged `stale`; `GET /instruction-sets/{id}/drift` lists the flags and publish
  is blocked until an expert re-verifies the steps or edits them.
* API keys per role (`expert`, `reviewer`, `admin`), OpenAPI docs at `/docs`, Prometheus
  metrics at `/metrics`.

## Quick start

```
make setup      # uv sync (Python 3.12)
make lint       # ruff
make test       # pytest against PostgreSQL via Testcontainers
make demo       # compose up (api + postgres + fake targets), migrate, run the demo
make down       # stop the stack and drop its volume
```

The API listens on `http://localhost:8090`, the fake webhook and Jira on
`http://localhost:8081`. Default keys are in `.env.example`
(`dana` expert, `ravi` and `mei` reviewers, `ops` admin).

## Demo

`make demo` registers eight sources, ingests three real expert notes from `samples/`
(a refund-handling SOP, an onboarding checklist, an incident triage note), shows the
citations, routes an edit through review, runs test cases, blocks one set on a
forbidden-action test, fixes and re-reviews it, publishes to the fake webhook and Jira
targets, and rolls one set back. The summary it prints is computed from the API's own
records:

```
== Running test cases and publishing approved sets
  set 2 v1: PASSED (3 passed, 0 failed)
  set 3 v2: PASSED (2 passed, 0 failed)
  set 1 v1: FAILED (2 passed, 1 failed)
    FAIL high value refund needs manager approval: required action not taken: 'manager'; forbidden action taken: 'Issue the refund'; execution was expected to halt but ran to completion
  set 2 v1: delivered to webhook (receipt whr-1)
  set 2 v1: delivered to jira (receipt 10002)
  set 3 v2: delivered to webhook (receipt whr-4)
  set 3 v2: delivered to jira (receipt 10005)
  set 1: publish BLOCKED: publish blocked: failing test cases: high value refund needs manager approval

== Summary
  notes ingested:        3
  steps compiled:        18
  citations linked:      26 (18/18 steps cited, 100%)
  edits recorded:        3
  approvals:             7 (changes requested: 1)
  test runs:             5 (4 green, 1 red; 13 cases passed, 1 failed)
  publishes blocked:     1
  publishes delivered:   8 deliveries (4 versions to 2 targets), rollbacks: 1
  receipts:              5 webhook (signed), 5 Jira comments, 5 Jira attachments
  states:                set 1=published (live v2), set 2=published (live v1), set 3=published (live v2)
```

## API reference

All endpoints take `X-API-Key`. `admin` may call everything.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/sources` | expert | Register a source (`url`, `doc`, `ticket`) with optional content; returns its hash |
| GET | `/sources` | expert, reviewer | List sources |
| POST | `/sources/{id}/rehash` | expert, reviewer | Re-hash a source (optional new `content`); flags citing steps when the hash changed |
| POST | `/sources/check-drift` | expert, reviewer | Re-scan every live instruction set against current source hashes |
| POST | `/notes` | expert | Ingest a note and compile instruction set v1 (optional `required_approvals`, `review_policy`); returns coverage and sources linked |
| GET | `/notes`, `/notes/{id}` | expert, reviewer | Read notes |
| GET | `/instruction-sets` | expert, reviewer | List sets with state and versions |
| GET | `/instruction-sets/{id}` | expert, reviewer | Full document |
| GET | `/instruction-sets/{id}/prompt` | expert, reviewer | Rendered agent prompt (text) |
| GET | `/instruction-sets/{id}/citations` | expert, reviewer | Coverage plus per-citation hash verification |
| GET | `/instruction-sets/{id}/versions` | expert, reviewer | Version snapshots |
| GET | `/instruction-sets/{id}/drift` | expert, reviewer | Stale steps and open or resolved drift flags |
| POST | `/instruction-sets/{id}/drift/verify` | expert | Re-verify stale steps (`step_ids`, or all) against the changed source |
| PATCH | `/instruction-sets/{id}` | expert | Edit: `expected_version`, `reason`, full `document`; 409 on stale version, 422 on uncited steps |
| GET | `/instruction-sets/{id}/edits` | expert, reviewer | Edit history with diffs |
| POST | `/instruction-sets/{id}/submit` | expert | `draft` or `changes_requested` to `in_review` |
| POST | `/instruction-sets/{id}/review` | reviewer | `approve` or `request_changes` with comment |
| GET | `/instruction-sets/{id}/reviews`, `/audit` | expert, reviewer | Review decisions and audit trail |
| PUT | `/instruction-sets/{id}/policy` | expert | Set `review_policy` (`required_roles`, `allow_self_approval`, `review_deadline_hours`) and `required_approvals`; 409 while in review |
| GET | `/reviews/workload` | reviewer | Queue of sets in review with deadlines, missing roles and per-reviewer pending, overdue and decided counts |
| POST | `/reviews/escalate` | reviewer | Escalate every overdue review once; the scheduler runs this too |
| POST | `/instruction-sets/{id}/test-cases` | expert, reviewer | Add a test case (`scenario`, `expectations`) |
| POST | `/instruction-sets/{id}/run-tests` | expert, reviewer | Execute all cases on the current version |
| GET | `/instruction-sets/{id}/test-cases`, `/test-runs` | expert, reviewer | Cases and recorded runs |
| POST | `/instruction-sets/{id}/publish` | admin | Deliver to targets; 409 when not approved, stale, or latest run is not green |
| POST | `/instruction-sets/{id}/rollback` | admin | Re-deliver the previous published version |
| POST | `/instruction-sets/{id}/retire` | admin | `published` to `retired` |
| GET | `/instruction-sets/{id}/publications` | expert, reviewer | Delivery receipts |
| GET | `/healthz`, `/metrics` | none | Health and Prometheus metrics |

Test case expectations: `required_actions`, `forbidden_actions`, `expected_outcomes`,
`expected_tools` (substring matches against the execution trace), `must_halt`,
`must_complete`. Scenarios carry `facts` (compared by conditions such as
`amount is over 500`, `reason is fraud`, `error rate exceeds 5 percent`) and `flags`
(free-text conditions that are simply true).

## Data model

| Table | Purpose |
| --- | --- |
| `sources` | `kind`, `ref`, optional content, `content_hash` (SHA-256), `last_checked_at`, unique per kind and ref |
| `notes` | Raw expert notes with author |
| `instruction_sets` | Head document (JSONB), `state`, `version`, `published_version`, `required_approvals`, `review_policy` (JSONB), `review_round`, `submitted_at`, `review_deadline_at`, `escalated_at` |
| `instruction_set_versions` | Immutable document snapshot per version |
| `edits` | Author, from/to version, reason, unified diff |
| `review_decisions` | Reviewer, role, version, review round, decision, comment |
| `audit_events` | Actor, action, from/to state, detail for every change |
| `test_cases` | Name, author, scenario, expectations |
| `test_runs` | Version covered, status, pass/fail counts, per-case results and traces |
| `publications` | Version, action (`publish`, `rollback`), target, status, receipt |
| `drift_flags` | Step, source, cited and current hash, detected by and at, resolution (`reverified`, `edited`) |

Schema is managed by Alembic (`alembic/versions/`).

## Configuration

Environment variables (prefix `EXPERTLOOP_`, see `.env.example`): `DATABASE_URL`,
`API_KEYS` (`name:role:key,...`), `WEBHOOK_URL`, `WEBHOOK_SECRET`, `JIRA_BASE_URL`,
`JIRA_ISSUE_KEY`, `JIRA_TOKEN`, `DEFAULT_REQUIRED_APPROVALS`, `DRIFT_CHECK_INTERVAL_SECONDS`
(0 disables the scheduled scan).

## Layout

```
expertloop/
  compiler/    note parser and rule-based compiler with citations
  sources/     source registry and citation verification
  workflow/    approval state machine
  executor/    deterministic executor and test case runner
  targets/     signed webhook and Jira delivery adapters
  fakes/       fake webhook receiver and Jira for demos and tests
  routers/     FastAPI routes
  drift.py     source re-hashing, drift flags and the scan scheduler
  reviews.py   review policies, deadlines, escalation and reviewer workload
  service.py   audited business logic
  demo.py      end-to-end demo driver
alembic/       migrations
deploy/        docker-compose stack
samples/       three expert notes used by the demo and tests
tests/         pytest suite (PostgreSQL via Testcontainers)
```

See `ARCHITECTURE.md` for the compiler, citation, state machine, gating and delivery
design, and `CONTRIBUTING.md` for the development workflow.

## Changelog

### 3.0.0

* Review policies per instruction set: required reviewer roles, no self-approval of a
  version you authored (unless the policy allows it), and review deadlines.
* Overdue reviews are escalated with an audit event, on demand or by the scheduler;
  `GET /reviews/workload` lists the queue and per-reviewer load.
* Migration `0003` adds `review_policy`, `submitted_at`, `review_deadline_at` and
  `escalated_at` to `instruction_sets`.

### 2.0.0

* Source drift detection: re-hash sources on demand or on a schedule, flag citing steps
  as stale, block publish until an expert re-verifies or edits them, and report it all
  through `GET /instruction-sets/{id}/drift`.
* Migration `0002` adds `drift_flags` and `sources.last_checked_at`.

### 1.0.0

* Initial release: deterministic note compiler with citations, source registry with
  hashes, edit history with optimistic concurrency, review state machine, test-case
  publish gate, signed webhook and Jira targets, rollback.

## License

MIT
