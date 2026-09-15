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
* **Executor plugins, coverage and ops overview.** Executor conditions are evaluated by
  a small plugin registry (`flags`, `membership`, `compare` built in; register your own
  with `expertloop.executor.registry.register`). `GET /instruction-sets/{id}/coverage`
  reports which steps and decision rules the test cases exercise, every test run stores
  its coverage, and `GET /ops/overview` aggregates sets by state, coverage, drift,
  review SLAs and publish statistics.
* **Version diff and branching.** `GET /instruction-sets/{id}/diff?from=1&to=3` returns
  a structured, step-level diff (added, removed and changed steps with per-field before
  and after, plus section entries). `POST /instruction-sets/{id}/branch` copies a version
  (the published one by default) into a new draft for experimentation; the branch has its
  own edits, tests and review. `POST /instruction-sets/{branch}/merge` three-way merges
  it back into the parent head, taking one-sided changes and refusing with the list of
  conflicting steps and fields when both sides changed the same thing.
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

`make demo` registers eight sources, ingests three sample notes written for the demo from
`samples/` (a refund SOP, an onboarding checklist, an incident triage note), shows the
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

The instruction set ids come from the database, so those are the ids a fresh stack prints;
running `make demo` again without `make down` in between continues the sequence.
`make demo-check` runs the same script in process against an empty schema and asserts this
block line for line.

### Browser demo

`web/` is a static site that runs part of the platform in the browser. `web/src/sim/` is a
TypeScript port of the compile, drift, review, versioning, gate and delivery paths, so the
walkthrough executes those paths instead of replaying a recording; the executor condition
plugin registry, the coverage report and `GET /ops/overview` are not ported. It covers
citation coverage, stale sources, review policy and escalation, branch and merge conflicts,
the publish gate and rollback, and replays the run above with the summary block printed
here. The port is pinned to this repository by fixtures: `tests/test_golden.py` writes what
the Python compiler and executor produce into `samples/expected/`, and the browser
self-check reads those files and has to reproduce them. `cd web && npm ci && npm run verify`
runs its 61 assertions and produces `dist/`; see `web/README.md`.

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
| GET | `/instruction-sets/{id}/diff?from=&to=` | expert, reviewer | Step-level diff between two versions |
| POST | `/instruction-sets/{id}/branch` | expert | Copy a version (`from_version`, default published) into a new draft branch |
| GET | `/instruction-sets/{id}/branches` | expert, reviewer | Branches of a set |
| POST | `/instruction-sets/{id}/merge` | expert | Merge a branch into its parent (`reason`, `expected_parent_version`); 409 with `conflicts` |
| GET | `/instruction-sets/{id}/drift` | expert, reviewer | Stale steps and open or resolved drift flags |
| POST | `/instruction-sets/{id}/drift/verify` | expert | Re-verify stale steps (`step_ids`, or all) against the changed source |
| PATCH | `/instruction-sets/{id}` | expert | Edit: `expected_version`, `reason`, full `document`, optional `register_unknown_sources`; 409 on stale version, 422 when the document or a citation is not valid |
| GET | `/instruction-sets/{id}/edits` | expert, reviewer | Edit history with diffs |
| POST | `/instruction-sets/{id}/submit` | expert | `draft` or `changes_requested` to `in_review` |
| POST | `/instruction-sets/{id}/review` | reviewer | `approve` or `request_changes` with comment |
| GET | `/instruction-sets/{id}/reviews`, `/audit` | expert, reviewer | Review decisions and audit trail |
| PUT | `/instruction-sets/{id}/policy` | expert | Set `review_policy` (`required_roles`, `allow_self_approval`, `review_deadline_hours`) and `required_approvals`; 409 while in review |
| GET | `/reviews/workload` | reviewer | Queue of sets in review with deadlines, missing roles and per-reviewer pending, overdue and decided counts |
| POST | `/reviews/escalate` | reviewer | Escalate every overdue review once; the scheduler runs this too |
| POST | `/instruction-sets/{id}/test-cases` | expert, reviewer | Add a test case (`scenario`, `expectations`) |
| POST | `/instruction-sets/{id}/run-tests` | expert, reviewer | Execute all cases on the current version |
| GET | `/instruction-sets/{id}/test-cases`, `/test-runs` | expert, reviewer | Cases and recorded runs (each run carries its coverage) |
| GET | `/instruction-sets/{id}/coverage` | expert, reviewer | Steps and decision rules exercised by the test cases on the current version |
| POST | `/instruction-sets/{id}/publish` | admin | Deliver to targets; 409 when not approved, stale, or latest run is not green |
| POST | `/instruction-sets/{id}/rollback` | admin | Re-deliver the previous published version |
| POST | `/instruction-sets/{id}/retire` | admin | `published` to `retired` |
| GET | `/instruction-sets/{id}/publications` | expert, reviewer | Delivery receipts |
| GET | `/ops/overview` | expert, reviewer | Sets by state, coverage of latest runs, open drift, review SLAs, publish stats |
| GET | `/ops/plugins` | expert, reviewer | Registered executor condition plugins in evaluation order |
| GET | `/healthz`, `/metrics` | none | Health and Prometheus metrics |

Test case expectations: `required_actions`, `forbidden_actions`, `expected_outcomes`,
`expected_tools` (substring matches against the execution trace), `must_halt`,
`must_complete`. Scenarios carry `facts` (compared by conditions such as
`amount is over 500`, `reason is fraud`, `error rate exceeds 5 percent`) and `flags`
(free-text conditions that are simply true). Conditions are evaluated by the plugin
registry in `expertloop/executor/plugins.py`: a plugin returns True or False when it
understands a condition and None to pass; `flags`, `membership` (`role is one of admin,
owner`, `region is in eu, uk` or `region in (eu, uk)`; a bare English `in` is not a
membership operator, so `logged in user is admin` is a comparison) and `compare` ship built
in, and `registry.register(plugin, first=True)` puts a custom grammar ahead of them.

## Data model

| Table | Purpose |
| --- | --- |
| `sources` | `kind`, `ref`, optional content, `content_hash` (SHA-256), `last_checked_at`, unique per kind and ref |
| `notes` | Raw expert notes with author |
| `instruction_sets` | Head document (JSONB), `state`, `version`, `published_version`, `required_approvals`, `review_policy` (JSONB), `review_round`, `submitted_at`, `review_deadline_at`, `escalated_at`, `parent_id`, `branched_from_version`, `merged_at`, `merged_into_version` |
| `instruction_set_versions` | Immutable document snapshot per version |
| `edits` | Author, from/to version, reason, unified diff |
| `review_decisions` | Reviewer, role, version, review round, decision, comment |
| `audit_events` | Actor, action, from/to state, detail for every change |
| `test_cases` | Name, author, scenario, expectations |
| `test_runs` | Version covered, status, pass/fail counts, per-case results and traces, coverage summary |
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
  executor/    deterministic executor, condition plugin registry, test runner, coverage
  targets/     signed webhook and Jira delivery adapters
  fakes/       fake webhook receiver and Jira for demos and tests
  routers/     FastAPI routes (sources, notes, instruction sets, reviews, ops)
  drift.py     source re-hashing, drift flags and the scan scheduler
  reviews.py   review policies, deadlines, escalation and reviewer workload
  versioning.py step-level diff and three-way merge of documents
  service.py   audited business logic
  demo.py      end-to-end demo driver
alembic/       migrations
deploy/        docker-compose stack
samples/       three sample notes used by the demo and tests, and the compiler and
               executor fixtures the browser port is checked against
tests/         pytest suite (PostgreSQL via Testcontainers)
web/           static browser demo (Vite, React; ports the compile, drift, review,
               versioning, gate and delivery paths)
```

See `ARCHITECTURE.md` for the compiler, citation, state machine, gating and delivery
design, and `CONTRIBUTING.md` for the development workflow.

## Limitations

* The compiler is a fixed set of rules, not a parser for English. It has been exercised on
  the three sample notes, the golden fixtures in `samples/expected/` and the compiler unit
  tests. It handles `if X then Y` and `if X, Y` rules, `never` / `do not` / `must not`
  clauses, `so that` / `until` / `expected:` outcomes, and reads `do not proceed until X` as
  a guard on the step rather than a forbidden action. An `otherwise` clause is left in the
  step's action: `If X, do it, otherwise hold` compiles to one conditional step, so when X
  is false the executor skips the step and the else branch with it.
* Delivery adapters have been exercised against the fake business systems in
  `expertloop/fakes/server.py`, which check the shape of each request, and not against a
  Jira tenant or a production webhook receiver.
* The executor is a rule follower, not a model: it decides conditions with the plugin
  registry and has no notion of a step it does not understand.
* The browser demo ports part of the platform; `web/README.md` lists what is not ported.

## Releases

| Version | Theme | Adds |
| --- | --- | --- |
| 1.0.0 | Compile, review, gate, deliver | Deterministic note compiler with citations, source registry with hashes, edit history with optimistic concurrency, review state machine, test-case publish gate, signed webhook and Jira targets, rollback |
| 2.0.0 | Source drift | Re-hash sources on demand or on a schedule, stale flags on citing steps, publish blocked until re-verified or edited, `GET /instruction-sets/{id}/drift` |
| 3.0.0 | Review policies and SLAs | Required reviewer roles, no self-approval, review deadlines with escalation events, `GET /reviews/workload` |
| 4.0.0 | Diff and branching | Step-level diff between versions, branch a draft from a published version, merge back with conflict detection |
| 5.0.0 | Plugins, coverage, ops | Executor condition plugin registry, test coverage report per set and per run, `GET /ops/overview` |
| 5.1.0 | Typed documents and the browser demo | Pydantic document schema with provenance-checked citations, row locking on every write, idempotent delivery with an ADF Jira comment, golden compiler and executor fixtures, and the static browser demo in `web/` |

Each release ships with its Alembic migration, tests against PostgreSQL, and a changelog
entry below. Tags are `v1.0.0` through `v5.0.1`; 5.1.0 is the current head and is not tagged
yet.

## Changelog

### 5.1.0

* `expertloop/document.py` types the instruction document with pydantic. A citation now has
  to be a line range in the note the set was compiled from or a reference to a source of a
  known kind, so an empty citation object or a line past the end of the note is a 422 rather
  than provenance. An edit that cites a source the registry does not hold is refused unless
  it passes `register_unknown_sources`.
* Documents that leave out an optional list no longer reach a `KeyError`: `render_prompt` and
  the executor read every section with a default, and a decision rule without a condition is
  rejected at the boundary.
* The compiler reads `do not proceed until X` as a guard on the step rather than a forbidden
  action, and no longer treats a negated stop word as an instruction to halt. `membership`
  requires the operator to be spelled out, so `logged in user is admin` is a comparison.
* Delivery carries a `delivery_id` that is stable across retries, skips a target that already
  holds that version, posts the Jira comment as an Atlassian Document Format body, and audits
  a failed rollback.
* Every service function that writes state takes a row lock on the instruction set.
* `tests/test_golden.py` writes what the compiler and executor produce into
  `samples/expected/`, and the browser demo's self-check reproduces those files.
* `web/` is a static browser demo of the compile, drift, review, versioning, gate and
  delivery paths.

### 5.0.1

* `GET /ops/overview` counted a rollback once per delivery target; it now counts each
  rollback once, matching the demo summary.

### 5.0.0

* Executor conditions go through a plugin registry (`flags`, `membership`, `compare`
  built in); deployments register their own grammars.
* `GET /instruction-sets/{id}/coverage` reports the steps and decision rules the test
  cases exercise; every test run stores a coverage summary.
* `GET /ops/overview` aggregates sets by state, coverage, drift, review SLAs and publish
  statistics; `GET /ops/plugins` lists the registry.
* Migration `0005` adds `test_runs.coverage`.

### 4.0.0

* Step-level diff between any two versions of an instruction set.
* Branch a draft from a published (or any) version, work on it in isolation, and merge
  it back with three-way conflict detection; conflicts are audited and returned as 409.
* Migration `0004` adds `parent_id`, `branched_from_version`, `merged_at` and
  `merged_into_version` to `instruction_sets`.

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
