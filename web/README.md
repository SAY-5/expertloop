# ExpertLoop browser demo

A static site that runs the ExpertLoop platform in the browser. No backend, no database, no
network calls: `src/sim/` is a pure TypeScript port of the Python packages under `expertloop/`,
so the walkthrough drives the same compiler, state machine, executor and delivery targets the
API drives.

## What it covers

| Section | Ported from |
| --- | --- |
| Compile and cite | `compiler/parser.py`, `compiler/compile.py`, `sources/registry.py` |
| Source drift | `drift.py` (per-step hashes, flags, the stale-step publish block, re-verify) |
| Edit and review | `service.py`, `workflow/state.py` (diffs, optimistic concurrency, transitions) |
| Review policy and workload | `reviews.py` (required roles, self-approval, deadlines, escalation) |
| Versions, branches, merges | `versioning.py` (structured diff, three-way merge, conflicts) |
| Test gate and delivery | `executor/run.py`, `targets/` (signed webhook, Jira comment and attachment) |
| The whole run | `demo.py` (the same script, with the summary block it prints) |

The port is deterministic: a seeded PRNG, a virtual clock and sequential ids, with no
`Math.random`, no `Date.now` and no `eval`. Two runs of the demo produce identical records.

## Commands

```
npm install
npm run dev        # vite dev server
npm run selfcheck  # 52 assertions over the ported simulation, exits non-zero on failure
npm run bundle     # typecheck and produce dist/ (alias of npm run build)
npm run verify     # selfcheck followed by the bundle
```

`npm run selfcheck` is the important one: it asserts the SHA-256 and HMAC vectors, that each
sample note compiles with every step cited, that a red case blocks publication, that a changed
source flags its steps and blocks publication until re-verified, that branches merge and
conflict, that review policies hold approvals and escalate past a deadline, and that the demo
summary reproduces the block quoted in the top-level README character for character. The same
assertions run in the browser and are listed in the page footer.

## Deployment

`vercel.json` sets the build command and `dist` as the output directory. Any static host works;
the site is a single bundle with no runtime configuration.
