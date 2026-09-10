import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type Citation, type InstructionDocument, citationCoverage } from "../sim/compile";
import { SAMPLE_NOTES, type NoteKey } from "../sim/fixtures";
import { type CitationReport } from "../sim/registry";
import { useWorld } from "../store";
import { NotePaper } from "./NotePaper";

type Range = [number, number] | null;

function lineLabel(c: Citation): string {
  return c.line_start === c.line_end ? `L${c.line_start}` : `L${c.line_start}-${c.line_end}`;
}

function CitationChip({
  cite,
  verified,
  onRange,
}: {
  cite: Citation;
  verified: boolean;
  onRange: (r: Range) => void;
}) {
  const range: Range = [cite.line_start, cite.line_end];
  const label = cite.source_ref ? `${cite.source_kind}:${cite.source_ref}` : lineLabel(cite);
  const hash = cite.source_hash ? cite.source_hash.slice(0, 8) : null;
  return (
    <button
      type="button"
      className={`chip cite-chip ${cite.source_ref ? (verified ? "chip-ok" : "chip-bad") : "chip-plum"}`}
      onMouseEnter={() => onRange(range)}
      onMouseLeave={() => onRange(null)}
      onFocus={() => onRange(range)}
      onBlur={() => onRange(null)}
      aria-label={`citation ${label}, note lines ${cite.line_start} to ${cite.line_end}${cite.source_ref ? (verified ? ", hash verified" : ", hash changed") : ""}`}
    >
      {label}
      {hash ? <span className="cite-hash">{hash}</span> : null}
      {cite.source_ref ? <span aria-hidden="true">{verified ? "✓" : "!"}</span> : null}
    </button>
  );
}

function Entry({
  kind,
  text,
  citations,
  verify,
  onRange,
}: {
  kind: string;
  text: string;
  citations: Citation[];
  verify: (c: Citation) => boolean;
  onRange: (r: Range) => void;
}) {
  return (
    <motion.li className="compile-entry" variants={entryVariants}>
      <span className="compile-kind mono">{kind}</span>
      <span className="compile-text">{text}</span>
      <span className="compile-cites">
        {citations.map((c, i) => (
          <CitationChip key={i} cite={c} verified={verify(c)} onRange={onRange} />
        ))}
      </span>
    </motion.li>
  );
}

const entryVariants = {
  hidden: { opacity: 0, x: 14 },
  show: { opacity: 1, x: 0 },
};

export function CompileSection() {
  const { world, version } = useWorld();
  const reduced = useReducedMotion();
  const [key, setKey] = useState<NoteKey>("refund");
  const [range, setRange] = useState<Range>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const note = SAMPLE_NOTES.find((n) => n.key === key)!;
  const set = world.service.getSet(world.sets[key]);
  const document: InstructionDocument = set.document;
  const coverage = useMemo(() => citationCoverage(document), [document]);
  const report = useMemo(() => world.service.registry.verifyCitations(document), [document, world, version]);
  const sources = world.service.registry.list();

  const verify = (c: Citation): boolean => {
    if (!c.source_id) return true;
    const row = report.find((r: CitationReport) => r.source_id === c.source_id && r.line_start === c.line_start && r.source_ref === c.source_ref);
    return row ? row.verified : true;
  };

  const verifiedCount = report.filter((r) => r.verified).length;

  return (
    <section className="section compile" id="compile" aria-labelledby="compile-title">
      <div className="shell">
        <div className="section-head">
          <div>
            <p className="eyebrow">01 / Compile and cite</p>
            <h2 id="compile-title">
              Every step <em>points back</em> to a line.
            </h2>
          </div>
          <p>
            The parser keeps a 1-based line range for every item. The compiler extracts preconditions, steps,
            decision rules, tools, outcomes and forbidden clauses, and refuses any document with an uncited
            step. Hover a chip to light up the lines it came from.
          </p>
          <span className="section-num" aria-hidden="true">
            01
          </span>
        </div>

        <div className="compile-picker" role="tablist" aria-label="sample note">
          {SAMPLE_NOTES.map((n) => (
            <button
              key={n.key}
              role="tab"
              type="button"
              aria-selected={n.key === key}
              className={`picker-tab${n.key === key ? " active" : ""}`}
              onClick={() => {
                setKey(n.key);
                setRange(null);
              }}
            >
              <span className="picker-title">{n.short}</span>
              <span className="picker-file mono">samples/{n.file}</span>
            </button>
          ))}
          <div className="compile-coverage" aria-live="polite">
            <span className="chip chip-plum">{coverage.cited_steps}/{coverage.steps} steps cited</span>
            <span className="chip">{coverage.citations} citations</span>
            <span className="chip chip-ok">{Math.round(coverage.coverage * 100)}% coverage</span>
            <span className="chip">
              {verifiedCount}/{report.length} verified
            </span>
          </div>
        </div>

        <div className="compile-grid">
          <div className="compile-note">
            <NotePaper body={note.body} title={`samples/${note.file}`} highlight={range} />
          </div>

          <div className="compile-out glass">
            <div className="compile-out-head">
              <div>
                <span className="eyebrow">instruction set {set.id}</span>
                <h3 className="compile-out-title">{document.title}</h3>
              </div>
              <div className="compile-out-tools">
                <button type="button" className={`btn btn-ghost${showPrompt ? " active" : ""}`} onClick={() => setShowPrompt((v) => !v)} aria-pressed={showPrompt}>
                  {showPrompt ? "Structured view" : "Agent prompt"}
                </button>
              </div>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {showPrompt ? (
                <motion.pre
                  key={`prompt-${key}`}
                  className="compile-prompt"
                  initial={reduced ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  {document.agent_prompt}
                </motion.pre>
              ) : (
                <motion.ol
                  key={`doc-${key}`}
                  className="compile-list"
                  initial={reduced ? "show" : "hidden"}
                  animate="show"
                  exit={{ opacity: 0 }}
                  variants={{ hidden: {}, show: { transition: { staggerChildren: reduced ? 0 : 0.06 } } }}
                >
                  {document.preconditions.map((p, i) => (
                    <Entry key={`pre-${i}`} kind="pre" text={p.text} citations={p.citations} verify={verify} onRange={setRange} />
                  ))}
                  {document.steps.map((step) => (
                    <motion.li key={step.id} className="compile-entry compile-step" variants={entryVariants}>
                      <span className="compile-kind mono">{step.id}</span>
                      <span className="compile-text">
                        {step.condition ? <em className="compile-cond">only if {step.condition}: </em> : null}
                        {step.action}
                        <span className="compile-meta">
                          {step.tool ? <span className="chip chip-warn">tool {step.tool}</span> : null}
                          {step.decision_rules.map((r, i) => (
                            <span key={i} className={`chip ${r.halts ? "chip-bad" : ""}`}>
                              if {r.condition}: {r.then}
                            </span>
                          ))}
                          {step.expected_outcome ? <span className="chip">expected: {step.expected_outcome}</span> : null}
                        </span>
                      </span>
                      <span className="compile-cites">
                        {step.citations.map((c, i) => (
                          <CitationChip key={i} cite={c} verified={verify(c)} onRange={setRange} />
                        ))}
                      </span>
                    </motion.li>
                  ))}
                  {document.decision_rules.map((r, i) => (
                    <Entry key={`rule-${i}`} kind="rule" text={`if ${r.condition}: ${r.then}`} citations={r.citations ?? []} verify={verify} onRange={setRange} />
                  ))}
                  {document.forbidden_actions.map((f, i) => (
                    <Entry key={`never-${i}`} kind="never" text={f.text} citations={f.citations} verify={verify} onRange={setRange} />
                  ))}
                  {document.outcomes.map((o, i) => (
                    <Entry key={`done-${i}`} kind="done" text={o.text} citations={o.citations} verify={verify} onRange={setRange} />
                  ))}
                </motion.ol>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="registry glass">
          <div className="registry-head">
            <div>
              <span className="eyebrow">source registry</span>
              <h3>Content hashes behind every source chip</h3>
            </div>
            <a className="btn btn-ghost" href="#drift">
              Change one of these upstream
            </a>
          </div>
          <div className="registry-scroll">
            <table className="registry-table">
              <thead>
                <tr>
                  <th scope="col">kind</th>
                  <th scope="col">ref</th>
                  <th scope="col">title</th>
                  <th scope="col">sha256</th>
                  <th scope="col">citations</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => {
                  const rows = world.service.sets.flatMap((st) => world.service.registry.verifyCitations(st.document)).filter((r) => r.source_id === s.id);
                  const ok = rows.filter((r) => r.verified).length;
                  const changed = rows.length > 0 && ok < rows.length;
                  return (
                    <tr key={s.id} className={changed ? "registry-drift" : ""}>
                      <td className="mono">{s.kind}</td>
                      <td className="mono registry-ref">{s.ref}</td>
                      <td>{s.title}</td>
                      <td className="mono registry-hash" title={s.content_hash}>
                        {s.content_hash.slice(0, 16)}
                      </td>
                      <td>
                        {rows.length === 0 ? (
                          <span className="chip">unused</span>
                        ) : changed ? (
                          <span className="chip chip-bad">{rows.length - ok} unverified</span>
                        ) : (
                          <span className="chip chip-ok">{rows.length} verified</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
