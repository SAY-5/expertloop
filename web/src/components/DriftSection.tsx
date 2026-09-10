import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type DemoWorld, createApprovedWorld, receiptId } from "../sim/demo";
import { PEOPLE } from "../sim/fixtures";
import { Conflict } from "../sim/service";
import { IllegalTransition } from "../sim/state";
import { useWorld } from "../store";

const ORIGINAL = "Handbook, engineering wiki, on-call primer, expense policy.";
const REWRITTEN = "Handbook, engineering wiki, on-call primer, expense policy, laptop pickup desk, badge office.";
const DRIFT_REF = "onboarding/week-one";

interface Line {
  id: number;
  kind: "ok" | "bad" | "info" | "blocked";
  text: string;
}

interface HashRow {
  step_id: string;
  action: string;
  source_ref: string;
  source_kind: string;
  cited: string;
  current: string;
  stale: boolean;
}

export function DriftSection() {
  const { toast } = useWorld();
  const reduced = useReducedMotion();
  const [world, setWorld] = useState<DemoWorld>(() => createApprovedWorld());
  const [tick, setTick] = useState(0);
  const [log, setLog] = useState<Line[]>([]);

  const bump = () => setTick((t) => t + 1);
  const push = (kind: Line["kind"], text: string) => setLog((l) => [{ id: (l[0]?.id ?? 0) + 1, kind, text }, ...l].slice(0, 12));

  const service = world.service;
  const setId = world.sets.onboarding;
  const set = service.getSet(setId);
  const report = service.driftFor(setId);
  const source = service.registry.find("doc", DRIFT_REF);
  const rewritten = source?.content === REWRITTEN;

  const rows = useMemo<HashRow[]>(() => {
    const out: HashRow[] = [];
    for (const step of set.document.steps) {
      for (const cite of step.citations) {
        if (!cite.source_id) continue;
        const registered = service.registry.byId(cite.source_id);
        if (!registered) continue;
        out.push({
          step_id: step.id,
          action: step.action,
          source_ref: registered.ref,
          source_kind: registered.kind,
          cited: cite.source_hash ?? "",
          current: registered.content_hash,
          stale: (cite.source_hash ?? "") !== registered.content_hash,
        });
      }
    }
    return out;
    // the service is mutated in place, so `tick` is what makes this recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, service, tick]);

  const rehash = () => {
    if (!source) return;
    const next = rewritten ? ORIGINAL : REWRITTEN;
    const changed = service.rehashSource(PEOPLE.ops, source.id, next);
    const stale = service.driftFor(setId).stale_steps;
    push(
      changed && stale.length ? "bad" : "info",
      changed
        ? `doc:${DRIFT_REF} re-hashed to sha256:${source.content_hash.slice(0, 12)}; flagged ${stale.length ? stale.join(", ") : "no steps"}`
        : `doc:${DRIFT_REF} re-hashed with no change`,
    );
    toast(
      rewritten ? `doc:${DRIFT_REF} restored upstream` : `doc:${DRIFT_REF} changed upstream: ${stale.join(", ")} now stale`,
      rewritten ? "ok" : "bad",
    );
    bump();
  };

  const publish = () => {
    try {
      const out = service.publish(PEOPLE.ops, setId, world.targets);
      for (const pub of out.publications) push("ok", `v${pub.version} delivered to ${pub.target} (receipt ${receiptId(pub)})`);
      toast(`v${out.set.published_version} published to webhook and Jira`, "ok");
    } catch (error) {
      if (error instanceof Conflict || error instanceof IllegalTransition) {
        push("blocked", `publish BLOCKED (409): ${error.message}`);
        toast(`409: ${error.message}`, "bad");
      } else throw error;
    }
    bump();
  };

  const reverify = () => {
    try {
      const resolved = service.reverify(PEOPLE.dana, setId);
      push("ok", `dana re-verified ${resolved.map((f) => f.step_id).join(", ")} against the new content; flags closed as reverified`);
      toast("Drift re-verified: the citation now carries the current hash", "ok");
    } catch (error) {
      push("info", (error as Error).message);
    }
    bump();
  };

  const editStale = () => {
    const stale = report.stale_steps;
    if (!stale.length) {
      push("info", "no stale steps to edit");
      return;
    }
    const document = JSON.parse(JSON.stringify(set.document)) as typeof set.document;
    for (const step of document.steps) {
      if (stale.includes(step.id)) step.action += " and the badge office details";
    }
    try {
      const edit = service.applyEdit(PEOPLE.dana, setId, set.version, "follow the rewritten week-one doc", document);
      push("info", `edit ${edit.id}: v${edit.from_version} -> v${edit.to_version}; flags closed as edited, state ${service.getSet(setId).state}`);
      toast("Edited the stale step: the flag closes, but the run now covers an older version", "info");
    } catch (error) {
      push("bad", (error as Error).message);
    }
    bump();
  };

  const reset = () => {
    setWorld(createApprovedWorld());
    setLog([]);
    bump();
  };

  const staleCount = report.open;
  const gate = staleCount ? "stale" : set.state === "published" ? "published" : "clear";

  return (
    <section className="section drift" id="drift" aria-labelledby="drift-title">
      <div className="shell">
        <div className="section-head">
          <div>
            <p className="eyebrow">02 / Source drift</p>
            <h2 id="drift-title">
              A rewritten policy makes a step <em>stale</em>.
            </h2>
          </div>
          <p>
            Every citation keeps the hash its source had when the step was compiled. Re-hashing a source and
            finding a different digest flags each step that cites it, and an open flag blocks publication until
            an expert re-verifies the step or edits it against the new text.
          </p>
          <span className="section-num" aria-hidden="true">
            02
          </span>
        </div>

        <div className="drift-grid">
          <div className="glass drift-table-card">
            <div className="panel-head">
              <div>
                <span className="eyebrow">citation hashes, set {set.id}</span>
                <h3>{set.name}</h3>
              </div>
              <div className="review-badges">
                <span className="chip chip-plum">v{set.version}</span>
                <span className={`chip state-${set.state}`}>{set.state.replace("_", " ")}</span>
                <span className={`chip ${staleCount ? "chip-bad" : "chip-ok"}`} aria-live="polite">
                  {staleCount ? `${staleCount} stale` : "all hashes match"}
                </span>
              </div>
            </div>
            <div className="drift-scroll">
              <table className="drift-table">
                <caption className="sr-only">Per-step citation hashes compared with the source registry</caption>
                <thead>
                  <tr>
                    <th scope="col">step</th>
                    <th scope="col">source</th>
                    <th scope="col">hash at compile time</th>
                    <th scope="col">hash in the registry</th>
                    <th scope="col">state</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.step_id}-${row.source_ref}`} className={row.stale ? "drift-row-stale" : ""}>
                      <th scope="row" className="mono">
                        {row.step_id}
                        <span className="drift-action">{row.action}</span>
                      </th>
                      <td className="mono drift-ref">
                        {row.source_kind}:{row.source_ref}
                      </td>
                      <td className="mono drift-hash">{row.cited.slice(0, 16)}</td>
                      <td className="mono drift-hash">{row.current.slice(0, 16)}</td>
                      <td>
                        <span className={`chip ${row.stale ? "chip-bad" : "chip-ok"}`}>{row.stale ? "stale" : "verified"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="drift-flags">
              <span className="eyebrow">drift flags</span>
              <ul className="flag-list">
                {report.flags.length === 0 ? <li className="feed-empty">No flags: every cited hash still matches the registry.</li> : null}
                <AnimatePresence initial={false}>
                  {report.flags
                    .slice()
                    .reverse()
                    .map((flag) => (
                      <motion.li
                        key={flag.id}
                        className={`flag flag-${flag.resolved_at === null ? "open" : "closed"}`}
                        initial={reduced ? false : { opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25 }}
                      >
                        <span className="chip chip-plum">{flag.step_id}</span>
                        <span className="mono flag-hashes">
                          {flag.cited_hash.slice(0, 10)} to {flag.current_hash.slice(0, 10)}
                        </span>
                        <span className={`chip ${flag.resolved_at === null ? "chip-bad" : "chip-ok"}`}>
                          {flag.resolved_at === null ? `open, found by ${flag.detected_by}` : `${flag.resolution} by ${flag.resolved_by}`}
                        </span>
                      </motion.li>
                    ))}
                </AnimatePresence>
              </ul>
            </div>
          </div>

          <div className="drift-side">
            <div className="glass drift-panel">
              <span className="eyebrow">upstream document</span>
              <p className="drift-doc-ref mono">doc:{DRIFT_REF}</p>
              <p className={`drift-doc${rewritten ? " changed" : ""}`}>{source?.content}</p>
              <p className="drift-doc-hash mono">sha256:{source?.content_hash.slice(0, 32)}</p>
              <div className={`drift-state drift-state-${gate}`} aria-live="polite">
                {staleCount
                  ? `publish is blocked: ${report.stale_steps.join(", ")} cite a changed source`
                  : set.state === "published"
                    ? `published: live v${set.published_version}`
                    : "publish gate is clear on the drift check"}
              </div>
              <div className="drift-actions">
                <button type="button" className={rewritten ? "btn" : "btn btn-danger"} onClick={rehash}>
                  {rewritten ? "Restore the week-one doc" : "Rewrite the week-one doc upstream"}
                </button>
                <button type="button" className="btn btn-plum" onClick={publish} disabled={set.state !== "approved"}>
                  Publish as ops
                </button>
                <button type="button" className="btn" onClick={reverify} disabled={staleCount === 0}>
                  Re-verify the stale step
                </button>
                <button type="button" className="btn" onClick={editStale} disabled={staleCount === 0}>
                  Edit the stale step instead
                </button>
                <button type="button" className="btn btn-ghost" onClick={reset}>
                  Reset this panel
                </button>
              </div>
              <p className="drift-hint">
                Re-verifying stamps the current hash onto the citation and keeps the version. Editing writes a new
                version instead, which then needs its own review and test run.
              </p>
            </div>

            <div className="glass drift-log">
              <div className="panel-head">
                <span className="eyebrow">drift log</span>
                <span className="chip">
                  {report.open} open, {report.resolved} resolved
                </span>
              </div>
              <ul className="ledger-list" aria-live="polite">
                {log.length === 0 ? <li className="feed-empty">Rewrite the source, then try to publish.</li> : null}
                <AnimatePresence initial={false}>
                  {log.map((line) => (
                    <motion.li
                      key={line.id}
                      className={`feed-item feed-${line.kind}`}
                      initial={reduced ? false : { opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      {line.text}
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
