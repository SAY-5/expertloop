import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type DemoWorld, createSeededWorld } from "../sim/demo";
import { PEOPLE, type NoteKey } from "../sim/fixtures";
import { formatInstant, overdueHours } from "../sim/reviews";
import { Conflict } from "../sim/service";
import { IllegalTransition } from "../sim/state";
import { useWorld } from "../store";

const REVIEWERS = [PEOPLE.dana, PEOPLE.ravi, PEOPLE.mei, PEOPLE.ops];

/** Deadlines and role requirements the panel puts on each set before submitting it. */
const POLICIES: Record<NoteKey, { hours: number; roles: string[] }> = {
  refund: { hours: 4, roles: ["admin"] },
  onboarding: { hours: 24, roles: [] },
  incident: { hours: 2, roles: [] },
};

interface Line {
  id: number;
  kind: "ok" | "bad" | "info" | "blocked";
  text: string;
}

export function WorkloadSection() {
  const { toast } = useWorld();
  const reduced = useReducedMotion();
  const [world, setWorld] = useState<DemoWorld>(() => seed());
  // the service is mutated in place, so a counter is what re-reads it
  const [, setTick] = useState(0);
  const [log, setLog] = useState<Line[]>([]);

  const service = world.service;
  const bump = () => setTick((t) => t + 1);
  const push = (kind: Line["kind"], text: string) => setLog((l) => [{ id: (l[0]?.id ?? 0) + 1, kind, text }, ...l].slice(0, 10));

  const board = service.workload(REVIEWERS);
  const escalations = service.audit.filter((a) => a.action === "review_escalated");

  const advance = (hours: number) => {
    service.advance(hours);
    push("info", `clock advanced ${hours}h to ${formatInstant(service.now())}`);
    bump();
  };

  const escalate = () => {
    const escalated = service.escalateOverdue(PEOPLE.ops);
    if (!escalated.length) {
      push("info", "scheduler tick: nothing overdue that is not already escalated");
    } else {
      for (const set of escalated) {
        push("bad", `set ${set.id} escalated: deadline ${formatInstant(set.review_deadline_at)} passed on round ${set.review_round}`);
      }
      toast(`${escalated.length} overdue review${escalated.length === 1 ? "" : "s"} escalated`, "bad");
    }
    bump();
  };

  const decide = (who: "dana" | "ravi" | "mei" | "ops", setId: number, decision: "approve" | "request_changes") => {
    try {
      const out = service.review(PEOPLE[who], setId, decision, decision === "approve" ? "verified against the source documents" : "needs another pass");
      const missing = service.missingRoles(out.set);
      push(
        "ok",
        `set ${setId}: ${who} ${decision === "approve" ? "approved" : "requested changes"} (${out.approvals}/${out.set.required_approvals}` +
          `${missing.length ? `, still missing ${missing.join(", ")}` : ""}) -> ${out.set.state.replace("_", " ")}`,
      );
    } catch (error) {
      const kind = error instanceof IllegalTransition ? "409 illegal transition" : error instanceof Conflict ? "409 conflict" : "error";
      push("blocked", `${kind}: ${(error as Error).message}`);
      toast(`${kind}: ${(error as Error).message}`, "bad");
    }
    bump();
  };

  const reset = () => {
    setWorld(seed());
    setLog([]);
    bump();
  };

  return (
    <section className="section workload" id="workload" aria-labelledby="workload-title">
      <div className="shell">
        <div className="section-head">
          <div>
            <p className="eyebrow">04 / Review policy and workload</p>
            <h2 id="workload-title">
              Deadlines, required roles and who it <em>waits on</em>.
            </h2>
          </div>
          <p>
            Each set carries a policy: how many approvals it needs, which reviewer roles must be among them,
            whether the author of the current version may approve it, and how many hours a review may take.
            Submitting starts the clock; the scheduler writes an escalation for anything that runs past it.
          </p>
          <span className="section-num" aria-hidden="true">
            04
          </span>
        </div>

        <div className="workload-controls glass">
          <div className="clock">
            <span className="eyebrow">virtual clock</span>
            <span className="clock-value mono" aria-live="polite">
              {formatInstant(service.now())}
            </span>
          </div>
          <div className="workload-buttons">
            <button type="button" className="btn" onClick={() => advance(1)}>
              +1 hour
            </button>
            <button type="button" className="btn" onClick={() => advance(3)}>
              +3 hours
            </button>
            <button type="button" className="btn btn-danger" onClick={escalate}>
              Run the escalation sweep
            </button>
            <span className="chip">isolated copy of the seeded world</span>
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Reset this panel
            </button>
          </div>
          <span className="chip chip-plum" aria-live="polite">
            {escalations.length} escalation{escalations.length === 1 ? "" : "s"} written
          </span>
        </div>

        <div className="workload-grid">
          <div className="glass queue-card">
            <div className="panel-head">
              <span className="eyebrow">review queue</span>
              <span className="chip">{board.queue.length} in review</span>
            </div>
            <ul className="queue-list">
              {board.queue.length === 0 ? <li className="feed-empty">Nothing is in review: every set has been decided.</li> : null}
              <AnimatePresence initial={false}>
                {board.queue.map((row) => {
                  const late = overdueHours(row.review_deadline_at, board.generated_at);
                  return (
                    <motion.li
                      key={row.instruction_set_id}
                      className={`queue-row${row.overdue ? " overdue" : ""}`}
                      initial={reduced ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      <div className="queue-head">
                        <span className="chip chip-plum">set {row.instruction_set_id}</span>
                        <span className="queue-name">{row.name}</span>
                        <span className="chip">
                          v{row.version}, round {row.review_round}
                        </span>
                      </div>
                      <div className="queue-meta">
                        <span className="chip">
                          {row.approvals}/{row.required_approvals} approvals
                        </span>
                        {row.missing_roles.map((role) => (
                          <span key={role} className="chip chip-warn">
                            needs {"aeiou".includes(role[0]) ? "an" : "a"} {role}
                          </span>
                        ))}
                        <span className={`chip ${row.overdue ? "chip-bad" : "chip-ok"}`}>
                          due {formatInstant(row.review_deadline_at)}
                          {row.overdue ? ` (${late}h late)` : ""}
                        </span>
                        {row.escalated ? <span className="chip chip-bad">escalated</span> : null}
                      </div>
                      <div className="queue-waiting">
                        <span className="queue-label mono">waiting on</span>
                        {row.waiting_on.length === 0 ? <span className="chip">nobody</span> : null}
                        {row.waiting_on.map((name) => (
                          <span key={name} className="chip">
                            {name}
                          </span>
                        ))}
                      </div>
                      <div className="queue-actions">
                        {(["dana", "ravi", "mei", "ops"] as const).map((who) => (
                          <button
                            key={who}
                            type="button"
                            className={`btn btn-ghost${who === "dana" ? " btn-danger" : ""}`}
                            onClick={() => decide(who, row.instruction_set_id, "approve")}
                          >
                            {who} approves
                          </button>
                        ))}
                        <button type="button" className="btn btn-ghost" onClick={() => decide("mei", row.instruction_set_id, "request_changes")}>
                          mei requests changes
                        </button>
                      </div>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </div>

          <div className="workload-side">
            <div className="glass reviewer-card">
              <div className="panel-head">
                <span className="eyebrow">reviewers</span>
                <span className="chip">{service.reviews.length} decisions</span>
              </div>
              <ul className="reviewer-list">
                {board.reviewers.map((person) => (
                  <li key={person.name} className="reviewer">
                    <span className="reviewer-name">
                      {person.name} <span className="chip">{person.role}</span>
                    </span>
                    <span className="reviewer-load">
                      <span className={`chip ${person.pending.length ? "chip-plum" : ""}`}>{person.pending.length} pending</span>
                      <span className={`chip ${person.overdue ? "chip-bad" : ""}`}>{person.overdue} overdue</span>
                      <span className="chip">{person.decided} decided</span>
                    </span>
                    <span className="reviewer-sets mono">{person.pending.length ? `sets ${person.pending.join(", ")}` : "clear"}</span>
                  </li>
                ))}
              </ul>
              <p className="workload-hint">
                dana wrote all three notes, so the policy keeps her off her own reviews; her button is here to
                show the refusal.
              </p>
            </div>

            <div className="glass workload-log">
              <div className="panel-head">
                <span className="eyebrow">policy log</span>
                <span className="chip">{escalations.length} escalated</span>
              </div>
              <ul className="ledger-list" aria-live="polite">
                {log.length === 0 ? <li className="feed-empty">Advance the clock past a deadline, then run the sweep.</li> : null}
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

/** Three sets in review, each with its own policy, submitted an hour apart. */
function seed(): DemoWorld {
  const world = createSeededWorld();
  for (const key of ["refund", "onboarding", "incident"] as NoteKey[]) {
    const setId = world.sets[key];
    world.service.setReviewPolicy(PEOPLE.ops, setId, {
      required_roles: POLICIES[key].roles,
      review_deadline_hours: POLICIES[key].hours,
    });
    world.service.submit(PEOPLE.dana, setId);
    world.service.advance(1);
  }
  return world;
}
