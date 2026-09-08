import { memo } from "react";

interface NotePaperProps {
  body: string;
  /** Inclusive 1-based line range to highlight. */
  highlight?: [number, number] | null;
  /** Lines above this index render dimmed (used by the hero reveal). */
  revealUpTo?: number;
  compact?: boolean;
  title?: string;
  id?: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const REF = /(https?:\/\/[^\s)\]>"']+|\bdoc:[A-Za-z0-9_./-]+|\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b)/g;

function renderInline(text: string) {
  const parts = text.split(REF);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="note-ref">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export const NotePaper = memo(function NotePaper({ body, highlight, revealUpTo, compact, title, id }: NotePaperProps) {
  const lines = body.replace(/\n$/, "").split("\n");
  return (
    <div className={`paper note-paper${compact ? " note-compact" : ""}`} id={id}>
      <div className="note-topbar">
        <span className="note-dot" />
        <span className="note-file">{title ?? "expert note"}</span>
        <span className="note-count mono">{lines.length} lines</span>
      </div>
      <ol className="note-lines" aria-label="note source lines">
        {lines.map((line, index) => {
          const number = index + 1;
          const heading = HEADING.exec(line);
          const inRange = highlight ? number >= highlight[0] && number <= highlight[1] : false;
          const dimmed = revealUpTo !== undefined && number > revealUpTo;
          const classes = ["note-line"];
          if (heading) classes.push(heading[1].length === 1 ? "note-h1" : "note-h2");
          if (inRange) classes.push("note-hit");
          if (dimmed) classes.push("note-dim");
          if (!line.trim()) classes.push("note-blank");
          return (
            <li key={number} className={classes.join(" ")} data-line={number}>
              <span className="note-num mono" aria-hidden="true">
                {number}
              </span>
              <span className="note-text">{heading ? heading[2] : renderInline(line)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
});
