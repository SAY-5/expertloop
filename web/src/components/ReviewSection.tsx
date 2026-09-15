import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type InstructionDocument } from "../sim/compile";
import { parseDiff } from "../sim/diff";
import { PEOPLE } from "../sim/fixtures";
import { Conflict, Invalid } from "../sim/service";
import { type Action, IllegalTransition, type State, TRANSITIONS } from "../sim/state";
import { useWorld } from "../store";

const SET_KEY = "incident" as const;

const EDGE_LABEL: Record<Action, string> = {
  submit: "submit",
  request_changes: "request changes",
  resubmit: "resubmit",
  approve: "approve",
  edit_after_approval: "edit",
  publish: "publish",
  revise: "edit (revise)",
  retire: "retire",
};

/** The path a set walks when nothing goes wrong. */
const FLOW: { state: State; via?: Action }[] = [
  { state: "draft" },
  { state: "in_review", via: "submit" },
  { state: "approved", via: "approve" },
  { state: "published", via: "publish" },
  { state: "retired", via: "retire" },
];

/** The transitions that leave that path, listed rather than drawn. */
const SIDE_EDGES: Action[] = ["request_changes", "resubmit", "edit_after_approval", "revise"];

function StateMachine({ current, lastAction, shakeKey }: { current: State; lastAction: Action | null; shakeKey: number }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      key={shakeKey}
      className="sm-diagram"
      initial={false}
      animate={shakeKey && !reduced ? { x: [0, -8, 8, -5, 5, 0] } : { x: 0 }}
      transition={{ duration: 0.45 }}
    >
      <ol className="sm-flow" aria-label={`approval states, currently ${current.replace("_", " ")}`}>
        {FLOW.map(({ state, via }) => {
          const legal = via ? TRANSITIONS[via][0] === current : false;
          return (
            <li key={state} className="sm-flow-item">
              {via ? (
                <span className={`sm-arrow${legal ? " legal" : ""}${via === lastAction ? " hot" : ""}`}>
                  <span className="sm-arrow-mark" aria-hidden="true">
                    &rarr;
                  </span>
                  {EDGE_LABEL[via]}
                </span>
              ) : null}
              <span className={`sm-state${state === current ? " active" : ""}`}>
                {state.replace("_", " ")}
                {state === current ? <span className="sr-only"> (current state)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <ul className="sm-loops">
        {SIDE_EDGES.map((action) => {
          const [from, to] = TRANSITIONS[action];
          return (
            <li key={action} className={`sm-loop${from === current ? " legal" : ""}`}>
              <span className="sm-loop-action">{EDGE_LABEL[action]}</span> takes {from.replace("_", " ")} to{" "}
              {to.replace("_", " ")}
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}

interface Feed {
  id: number;
  kind: "ok" | "bad" | "info";
  text: string;
}

export function ReviewSection() {
  const { world, bump, toast } = useWorld();
  const reduced = useReducedMotion();
  const setId = world.sets[SET_KEY];
  const set = world.service.getSet(setId);
  const note = world.service.getNote(set.note_id);
  const [stepIndex, setStepIndex] = useState(5);
  const [draftAction, setDraftAction] = useState<string | null>(null);
  const [reason, setReason] = useState("announce mitigation in #incidents before acting");
  const [lastAction, setLastAction] = useState<Action | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [openEdit, setOpenEdit] = useState<number | null>(null);

  const step = set.document.steps[stepIndex];
  const actionText = draftAction ?? step.action;
  const edits = world.service.editsFor(setId);
  const reviews = world.service.reviewsFor(setId);
  const audit = world.service.auditFor(setId);
  const approvals = world.service.countApprovals(set);
  const shownEdit = useMemo(() => edits.find((e) => e.id === openEdit) ?? edits[edits.length - 1], [edits, openEdit]);
  const diffLines = useMemo(() => (shownEdit ? parseDiff(shownEdit.diff) : []), [shownEdit]);

  const push = (kind: Feed["kind"], text: string) => setFeed((f) => [{ id: (f[0]?.id ?? 0) + 1, kind, text }, ...f].slice(0, 6));

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof IllegalTransition ? "409 illegal transition" : error instanceof Conflict ? "409 conflict" : error instanceof Invalid ? "422 invalid" : "error";
    setShakeKey((k) => k + 1);
    push("bad", `${kind}: ${message}`);
    toast(`${kind}: ${message}`, "bad");
  };

  const applyEdit = (expectedVersion: number) => {
    const document = JSON.parse(JSON.stringify(set.document)) as InstructionDocument;
    document.steps[stepIndex].action = actionText.trim();
    try {
      const edit = world.service.applyEdit(PEOPLE.dana, setId, expectedVersion, reason.trim() || "edit", document);
      setDraftAction(null);
      setOpenEdit(edit.id);
      const after = world.service.getSet(setId).state;
      if (after !== set.state) setLastAction(set.state === "approved" ? "edit_after_approval" : "revise");
      push("ok", `edit ${edit.id}: v${edit.from_version} -> v${edit.to_version} by dana (${edit.reason}); state ${set.state} -> ${after}`);
      toast(`Edit recorded: v${edit.from_version} -> v${edit.to_version}`, "ok");
      bump();
    } catch (error) {
      fail(error);
    }
  };

  const act = (label: string, fn: () => Action | null) => {
    try {
      const action = fn();
      setLastAction(action);
      const after = world.service.getSet(setId);
      push("ok", `${label} -> ${after.state.replace("_", " ")} (v${after.version}, round ${after.review_round}, approvals ${world.service.countApprovals(after)}/${after.required_approvals})`);
      bump();
    } catch (error) {
      fail(error);
    }
  };

  const submit = () =>
    act("dana submitted", () => {
      const before = set.state;
      world.service.submit(PEOPLE.dana, setId);
      return before === "changes_requested" ? "resubmit" : "submit";
    });

  const review = (who: "ravi" | "mei" | "dana", decision: "approve" | "request_changes") =>
    act(`${who} ${decision === "approve" ? "approved" : "requested changes"}`, () => {
      const out = world.service.review(PEOPLE[who], setId, decision, decision === "approve" ? "verified against the source documents" : "step 6 must announce mitigation in #incidents first");
      if (decision === "request_changes") return "request_changes";
      return out.set.state === "approved" ? "approve" : null;
    });

  const publish = () =>
    act("ops published", () => {
      world.service.publish(PEOPLE.ops, setId, world.targets);
      return "publish";
    });

  const retire = () =>
    act("ops retired", () => {
      world.service.retire(PEOPLE.ops, setId);
      return "retire";
    });

  return (
    <section className="section review" id="review" aria-labelledby="review-title">
      <div className="shell">
        <div className="section-head">
          <div>
            <p className="eyebrow">03 / Edit and review</p>
            <h2 id="review-title">
              Every change is a <em>diff</em>, every approval a row.
            </h2>
          </div>
          <p>
            Edits send the whole document with an expected version; a stale version is a 409 and an uncited step
            is a 422. Reviews count per version and per round, the author cannot review their own note, and the
            transition table rejects anything it does not list.
          </p>
          <span className="section-num" aria-hidden="true">
            03
          </span>
        </div>

        <div className="review-grid">
          <div className="review-edit glass">
            <div className="panel-head">
              <div>
                <span className="eyebrow">instruction set {set.id}</span>
                <h3>{set.document.title}</h3>
              </div>
              <div className="review-badges">
                <span className="chip chip-plum">v{set.version}</span>
                <span className={`chip state-${set.state}`}>{set.state.replace("_", " ")}</span>
                <span className="chip">
                  {approvals}/{set.required_approvals} approvals
                </span>
              </div>
            </div>

            <label className="field">
              <span className="field-label">step</span>
              <select
                value={stepIndex}
                onChange={(e) => {
                  setStepIndex(Number(e.target.value));
                  setDraftAction(null);
                }}
              >
                {set.document.steps.map((s, i) => (
                  <option key={s.id} value={i}>
                    {s.id}: {s.action.slice(0, 64)}
                    {s.action.length > 64 ? "..." : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">action</span>
              <textarea rows={3} value={actionText} onChange={(e) => setDraftAction(e.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span className="field-label">reason</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="review-edit-actions">
              <button type="button" className="btn btn-plum" onClick={() => applyEdit(set.version)} disabled={actionText.trim() === step.action}>
                Apply edit as dana (expected v{set.version})
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDraftAction("Post the mitigation plan in #incidents, then " + step.action[0].toLowerCase() + step.action.slice(1))} disabled={stepIndex !== 5 || step.action.startsWith("Post the mitigation")}>
                Use ravi's suggestion
              </button>
              <button type="button" className="btn btn-danger" onClick={() => applyEdit(Math.max(1, set.version - 1))} title="Sends expected_version one behind the head to show optimistic concurrency">
                Send with stale version
              </button>
            </div>

            <div className="diff-wrap">
              <div className="diff-head">
                <span className="eyebrow">edit history</span>
                <div className="diff-tabs" role="group" aria-label="edits">
                  {edits.length === 0 ? <span className="chip">no edits yet</span> : null}
                  {edits.map((e) => (
                    <button key={e.id} type="button" aria-pressed={shownEdit?.id === e.id} className={`chip${shownEdit?.id === e.id ? " chip-plum" : ""}`} onClick={() => setOpenEdit(e.id)}>
                      v{e.from_version} to v{e.to_version}
                    </button>
                  ))}
                </div>
              </div>
              <AnimatePresence mode="wait" initial={false}>
                {shownEdit ? (
                  <motion.div key={shownEdit.id} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                    <p className="diff-meta mono">
                      edit {shownEdit.id} by {shownEdit.author}: {shownEdit.reason}
                    </p>
                    <pre className="diff" aria-label={`unified diff for edit ${shownEdit.id}`}>
                      {diffLines.slice(0, 80).map((line, i) => (
                        <span key={i} className={`diff-${line.kind}`}>
                          {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "context" ? " " : ""}
                          {line.text}
                          {"\n"}
                        </span>
                      ))}
                      {diffLines.length > 80 ? <span className="diff-hunk">{`... ${diffLines.length - 80} more lines`}</span> : null}
                    </pre>
                  </motion.div>
                ) : (
                  <motion.p key="empty" className="diff-empty" initial={false}>
                    Change a step and apply it: the service stores a unified diff of the canonical JSON, a version snapshot and an audit row.
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="review-flow">
            <div className="glass sm-card">
              <StateMachine current={set.state} lastAction={lastAction} shakeKey={shakeKey} />
              <div className="sm-legend">
                <span className="chip chip-plum">current state</span>
                <span className="chip legal-chip">legal from here</span>
                <span className="chip">everything else is 409</span>
              </div>
            </div>

            <div className="glass actors">
              <div className="actor">
                <span className="actor-name">
                  dana <span className="chip">expert, author of note {note.id}</span>
                </span>
                <div className="actor-actions">
                  <button type="button" className="btn" onClick={submit}>
                    Submit for review
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => review("dana", "approve")}>
                    Approve own note
                  </button>
                </div>
              </div>
              {(["ravi", "mei"] as const).map((who) => (
                <div className="actor" key={who}>
                  <span className="actor-name">
                    {who} <span className="chip">reviewer</span>
                  </span>
                  <div className="actor-actions">
                    <button type="button" className="btn" onClick={() => review(who, "approve")}>
                      Approve
                    </button>
                    <button type="button" className="btn btn-danger" onClick={() => review(who, "request_changes")}>
                      Request changes
                    </button>
                  </div>
                </div>
              ))}
              <div className="actor">
                <span className="actor-name">
                  ops <span className="chip">admin</span>
                </span>
                <div className="actor-actions">
                  <button type="button" className="btn" onClick={publish}>
                    Publish
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={retire}>
                    Retire
                  </button>
                </div>
              </div>
            </div>

            <div className="glass feed">
              <div className="panel-head">
                <span className="eyebrow">responses</span>
                <span className="chip">
                  {reviews.length} review decisions, {audit.length} audit rows
                </span>
              </div>
              <ul className="feed-list" aria-live="polite">
                <AnimatePresence initial={false}>
                  {feed.length === 0 ? (
                    <li className="feed-empty">Try publishing from draft, or let dana approve her own note, to see the service refuse.</li>
                  ) : null}
                  {feed.map((f) => (
                    <motion.li
                      key={f.id}
                      className={`feed-item feed-${f.kind}`}
                      initial={reduced ? false : { opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      {f.text}
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
              <details className="audit">
                <summary>audit trail ({audit.length})</summary>
                <ol className="audit-list">
                  {audit
                    .slice()
                    .reverse()
                    .map((a) => (
                      <li key={a.id} className="mono">
                        <span className="audit-actor">{a.actor}</span> {a.action}
                        {a.from_state || a.to_state ? ` ${a.from_state ?? "-"} -> ${a.to_state ?? "-"}` : ""}
                        {Object.keys(a.detail).length ? ` ${JSON.stringify(a.detail)}` : ""}
                      </li>
                    ))}
                </ol>
              </details>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
