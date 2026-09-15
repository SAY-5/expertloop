import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type InstructionDocument } from "../sim/compile";
import { type DemoWorld, createSeededWorld } from "../sim/demo";
import { PEOPLE } from "../sim/fixtures";
import { Conflict, type InstructionSet } from "../sim/service";
import { type Conflict as MergeConflict } from "../sim/versioning";
import { useWorld } from "../store";

interface Line {
  id: number;
  kind: "ok" | "bad" | "info" | "blocked";
  text: string;
}

/** Preset edits, so the branch and the parent can be pushed into agreement or into a clash. */
const BRANCH_STEP = 2;
const PARENT_STEP = 3;
const BRANCH_TEXT = "Invite the GitHub user as an outside collaborator on the named repositories only";
const PARENT_SAME_STEP_TEXT = "Invite the GitHub user to the organisation with the team from the access request form";
const PARENT_OTHER_TEXT = " and #eng-oncall";

function short(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text === undefined ? "-" : text.length > 120 ? text.slice(0, 117) + "..." : text;
}

export function VersionSection() {
  const { toast } = useWorld();
  const reduced = useReducedMotion();
  const [world, setWorld] = useState<DemoWorld>(() => createSeededWorld());
  const [tick, setTick] = useState(0);
  const [log, setLog] = useState<Line[]>([]);
  const [conflicts, setConflicts] = useState<MergeConflict[]>([]);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);

  const service = world.service;
  const parentId = world.sets.onboarding;
  const parent = service.getSet(parentId);
  const branch: InstructionSet | undefined = service.branchesOf(parentId)[0];

  const bump = () => setTick((t) => t + 1);
  const push = (kind: Line["kind"], text: string) => setLog((l) => [{ id: (l[0]?.id ?? 0) + 1, kind, text }, ...l].slice(0, 10));

  const versions = service.versionsFor(parentId).map((v) => v.version);
  const highest = versions[versions.length - 1] ?? 1;
  const left = Math.min(from, highest);
  const right = Math.min(Math.max(to, left), highest);

  const diff = useMemo(
    () => (left === right ? null : service.diffVersions(parentId, left, right)),
    // the service is mutated in place, so `tick` is what makes this recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parentId, left, right, service, tick],
  );

  const editSet = (setId: number, mutate: (doc: InstructionDocument) => void, reason: string) => {
    const current = service.getSet(setId);
    const document = JSON.parse(JSON.stringify(current.document)) as InstructionDocument;
    mutate(document);
    try {
      const edit = service.applyEdit(PEOPLE.dana, setId, current.version, reason, document);
      push("info", `set ${setId}: v${edit.from_version} -> v${edit.to_version} (${reason})`);
      if (setId === parentId) setTo(edit.to_version);
      setConflicts([]);
    } catch (error) {
      push("bad", (error as Error).message);
    }
    bump();
  };

  const makeBranch = () => {
    const child = service.branch(PEOPLE.dana, parentId, "Onboarding: contractor variant");
    push("ok", `branch ${child.id} created from v${child.branched_from_version} of set ${parentId}`);
    toast(`Branch ${child.id} is a draft copy of v${child.branched_from_version}`, "ok");
    bump();
  };

  const merge = () => {
    if (!branch) return;
    try {
      const out = service.merge(PEOPLE.dana, branch.id, `merge branch ${branch.id}`);
      setConflicts([]);
      push(
        "ok",
        `merged branch ${branch.id} into v${out.edit.to_version}: ${out.summary.steps_changed} step${out.summary.steps_changed === 1 ? "" : "s"} changed`,
      );
      setTo(out.edit.to_version);
      toast(`Branch ${branch.id} merged into v${out.edit.to_version}`, "ok");
    } catch (error) {
      if (error instanceof Conflict) {
        const list = (error.detail.conflicts as MergeConflict[]) ?? [];
        setConflicts(list);
        push("blocked", `merge BLOCKED (409): ${error.message}`);
        toast(`409: ${error.message}`, "bad");
      } else {
        push("bad", (error as Error).message);
      }
    }
    bump();
  };

  const reset = () => {
    setWorld(createSeededWorld());
    setLog([]);
    setConflicts([]);
    setFrom(1);
    setTo(1);
    bump();
  };

  const preview = branch && branch.merged_at === null ? service.previewMerge(branch.id) : [];
  const stepLabel = (index: number) => parent.document.steps[index]?.id ?? `s${index + 1}`;

  return (
    <section className="section versions" id="versions" aria-labelledby="versions-title">
      <div className="shell">
        <div className="section-head">
          <div>
            <p className="eyebrow">05 / Versions, branches and merges</p>
            <h2 id="versions-title">
              Try a change on a <em>branch</em>, merge it back.
            </h2>
          </div>
          <p>
            A branch is a draft copy of one version with its own edits, tests and review. Merging is a
            three-way compare against the version it was cut from: a change made on one side only is taken,
            and a field both sides moved differently comes back as a conflict instead of a silent overwrite.
          </p>
          <span className="section-num" aria-hidden="true">
            05
          </span>
        </div>

        <div className="versions-grid">
          <div className="versions-main">
            <div className="glass version-diff-card">
            <div className="panel-head">
              <div>
                <span className="eyebrow">structured diff, set {parent.id}</span>
                <h3>{parent.name}</h3>
              </div>
              <span className="chip chip-plum">head v{parent.version}</span>
            </div>

            <div className="version-rail" aria-label="versions of this set">
              {versions.map((v) => (
                <span key={v} className={`rail-node${v === right ? " current" : ""}${v === left ? " base" : ""}`}>
                  v{v}
                </span>
              ))}
              {branch ? (
                <span className={`rail-node rail-branch${branch.merged_at ? " merged" : ""}`}>
                  branch {branch.id} v{branch.version}
                  {branch.merged_at ? ` merged into v${branch.merged_into_version}` : ""}
                </span>
              ) : null}
            </div>

            <div className="version-picker">
              <label className="field field-inline">
                <span className="field-label">from</span>
                <select value={left} onChange={(e) => setFrom(Number(e.target.value))}>
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field field-inline">
                <span className="field-label">to</span>
                <select value={right} onChange={(e) => setTo(Number(e.target.value))}>
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                    </option>
                  ))}
                </select>
              </label>
              {diff ? (
                <div className="version-summary" aria-live="polite">
                  <span className="chip chip-plum">
                    {diff.summary.steps_changed} step{diff.summary.steps_changed === 1 ? "" : "s"} changed
                  </span>
                  <span className="chip">{diff.summary.steps_added} added</span>
                  <span className="chip">{diff.summary.steps_removed} removed</span>
                  <span className="chip">
                    {diff.summary.entries_added} entr{diff.summary.entries_added === 1 ? "y" : "ies"} added
                  </span>
                  <span className="chip">
                    {diff.summary.fields_changed} field{diff.summary.fields_changed === 1 ? "" : "s"} changed
                  </span>
                </div>
              ) : (
                <span className="chip">pick two versions to compare</span>
              )}
            </div>

            <ul className="version-changes">
              {!diff ? <li className="feed-empty">Only one version exists so far. Branch and merge, or edit the parent.</li> : null}
              {diff && diff.steps.changed.length === 0 && diff.steps.added.length === 0 ? (
                <li className="feed-empty">No step changes between these two versions.</li>
              ) : null}
              {diff?.steps.changed.map((change) => (
                <li key={change.id} className="version-change">
                  <span className="chip chip-plum">{change.id}</span>
                  <ul className="version-fields">
                    {Object.entries(change.fields).map(([field, value]) => (
                      <li key={field}>
                        <span className="mono version-field">{field}</span>
                        <span className="version-before">{short(value.before)}</span>
                        <span className="version-after">{short(value.after)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
            <div className="glass version-log">
              <div className="panel-head">
                <span className="eyebrow">branch log</span>
                <span className="chip">{service.editsFor(parentId).length} parent edits</span>
              </div>
              <ul className="ledger-list" aria-live="polite">
                {log.length === 0 ? <li className="feed-empty">Branch, edit both sides, then merge.</li> : null}
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

          <div className="versions-side">
            <div className="glass version-panel">
              <span className="eyebrow">branch and merge</span>
              <div className="version-actions">
                <button type="button" className="btn btn-plum" onClick={makeBranch} disabled={Boolean(branch)}>
                  Branch v{parent.published_version ?? parent.version} as a contractor variant
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!branch || branch.merged_at !== null}
                  onClick={() =>
                    branch &&
                    editSet(
                      branch.id,
                      (doc) => {
                        doc.steps[BRANCH_STEP].action = BRANCH_TEXT;
                      },
                      `branch: rewrite ${stepLabel(BRANCH_STEP)}`,
                    )
                  }
                >
                  On the branch: rewrite {stepLabel(BRANCH_STEP)}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    editSet(
                      parentId,
                      (doc) => {
                        doc.steps[PARENT_STEP].action += PARENT_OTHER_TEXT;
                      },
                      `parent: extend ${stepLabel(PARENT_STEP)}`,
                    )
                  }
                >
                  On the parent: extend {stepLabel(PARENT_STEP)}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() =>
                    editSet(
                      parentId,
                      (doc) => {
                        doc.steps[BRANCH_STEP].action = PARENT_SAME_STEP_TEXT;
                      },
                      `parent: rewrite ${stepLabel(BRANCH_STEP)} differently`,
                    )
                  }
                >
                  On the parent: rewrite {stepLabel(BRANCH_STEP)} differently
                </button>
                <button type="button" className="btn btn-plum" onClick={merge} disabled={!branch || branch.merged_at !== null}>
                  Merge the branch
                </button>
                <span className="chip">isolated copy of the seeded world</span>
                <button type="button" className="btn btn-ghost" onClick={reset}>
                  Reset this panel
                </button>
              </div>
              <p className="version-hint" aria-live="polite">
                {!branch
                  ? "Nothing is branched yet."
                  : branch.merged_at !== null
                    ? `Branch ${branch.id} landed in v${branch.merged_into_version} and cannot be merged twice.`
                    : preview.length
                      ? `${preview.length} field${preview.length === 1 ? "" : "s"} would conflict right now.`
                      : "A merge would apply cleanly right now."}
              </p>
            </div>

            <AnimatePresence initial={false}>
              {conflicts.length ? (
                <motion.div
                  key="conflicts"
                  className="glass conflict-card"
                  initial={reduced ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="panel-head">
                    <span className="eyebrow">merge conflicts</span>
                    <span className="chip chip-bad">409, nothing written</span>
                  </div>
                  <ul className="conflict-list">
                    {conflicts.map((conflict, i) => (
                      <li key={i} className="conflict">
                        <span className="chip chip-bad">
                          {conflict.kind === "step" ? `${conflict.step_id}.${conflict.field ?? "step"}` : String(conflict.field)}
                        </span>
                        <span className="conflict-side">
                          <span className="conflict-label mono">base</span>
                          {short(conflict.base)}
                        </span>
                        <span className="conflict-side">
                          <span className="conflict-label mono">parent</span>
                          {short(conflict.parent)}
                        </span>
                        <span className="conflict-side">
                          <span className="conflict-label mono">branch</span>
                          {short(conflict.branch)}
                        </span>
                        {conflict.reason ? <span className="conflict-reason">{conflict.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
