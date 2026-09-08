/**
 * Deterministic parser for expert task notes (port of expertloop/compiler/parser.py).
 *
 * Headings name a section (steps, preconditions, decision rules, tools, expected outcomes,
 * forbidden actions); unknown headings default to steps. Numbered or bulleted items fold
 * indented continuation lines into the item. Inline references are URLs, doc:<id> ids and
 * ticket keys such as FIN-2210. Every item remembers its 1-based line range for citations.
 */

export type SourceKind = "url" | "doc" | "ticket";

export interface SourceRef {
  kind: SourceKind;
  ref: string;
}

export type Section =
  | "preconditions"
  | "steps"
  | "decision_rules"
  | "tools"
  | "outcomes"
  | "forbidden";

export interface NoteItem {
  text: string;
  line_start: number;
  line_end: number;
  section: Section;
  sources: SourceRef[];
}

export interface ParsedNote {
  title: string | null;
  items: NoteItem[];
  sources: SourceRef[];
  line_count: number;
}

export const SECTION_ALIASES: Record<Section, string[]> = {
  preconditions: ["precondition", "prerequisite", "before you start", "before starting"],
  steps: ["step", "procedure", "process", "checklist", "how to", "workflow"],
  decision_rules: ["decision", "rule", "escalat", "when to", "thresholds"],
  tools: ["tool", "system", "systems to use"],
  outcomes: ["outcome", "expected result", "done when", "definition of done", "result"],
  forbidden: ["never", "do not", "don't", "forbidden", "must not", "prohibited"],
};

const ITEM_RE = /^(\s*)(?:(\d+)[.)]|[-*+])\s+(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s*(.+?)\s*#*\s*$/;
const URL_RE = /https?:\/\/[^\s)\]>"']+/g;
const DOC_RE = /\bdoc:([A-Za-z0-9_./-]+)/g;
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

export function sectionItems(note: ParsedNote, name: Section): NoteItem[] {
  return note.items.filter((item) => item.section === name);
}

export function classifyHeading(text: string): Section {
  const lowered = text.toLowerCase();
  for (const section of Object.keys(SECTION_ALIASES) as Section[]) {
    if (SECTION_ALIASES[section].some((needle) => lowered.includes(needle))) {
      return section;
    }
  }
  return "steps";
}

function stripTrailing(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

export function extractSources(text: string): SourceRef[] {
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  const add = (kind: SourceKind, ref: string) => {
    const key = `${kind}:${ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ kind, ref });
    }
  };
  for (const match of text.matchAll(URL_RE)) add("url", stripTrailing(match[0], ".,;"));
  let scrubbed = text.replace(URL_RE, " ");
  for (const match of scrubbed.matchAll(DOC_RE)) add("doc", stripTrailing(match[1], ".,;:"));
  scrubbed = scrubbed.replace(DOC_RE, " ");
  for (const match of scrubbed.matchAll(TICKET_RE)) add("ticket", match[1]);
  return refs;
}

function expandTabs(value: string, width = 4): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\t") out += " ".repeat(width - (out.length % width));
    else out += ch;
  }
  return out;
}

export function parseNote(body: string): ParsedNote {
  const lines = body.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "" && body.endsWith("\n")) lines.pop();
  let title: string | null = null;
  const items: NoteItem[] = [];
  let currentSection: Section = "steps";
  let openItem: NoteItem | null = null;
  let openIndent = 0;

  const close = () => {
    if (openItem !== null) {
      openItem.text = openItem.text.trim();
      openItem.sources = extractSources(openItem.text);
      items.push(openItem);
      openItem = null;
    }
  };

  lines.forEach((raw, index) => {
    const number = index + 1;
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      close();
      if (title === null && raw.trimStart().startsWith("# ")) {
        title = heading[1];
        return;
      }
      currentSection = classifyHeading(heading[1]);
      return;
    }
    const item = ITEM_RE.exec(raw);
    if (item) {
      const indent = expandTabs(item[1]).length;
      if (openItem !== null && indent > openIndent) {
        openItem.text += "\n" + item[3].trim();
        openItem.line_end = number;
        return;
      }
      close();
      openItem = {
        text: item[3],
        line_start: number,
        line_end: number,
        section: currentSection,
        sources: [],
      };
      openIndent = indent;
      return;
    }
    if (raw.trim() === "") {
      close();
      return;
    }
    if (openItem !== null) {
      openItem.text += "\n" + raw.trim();
      openItem.line_end = number;
      return;
    }
    openItem = {
      text: raw.trim(),
      line_start: number,
      line_end: number,
      section: currentSection,
      sources: [],
    };
    openIndent = 0;
  });
  close();

  const allSources: SourceRef[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const ref of item.sources) {
      const key = `${ref.kind}:${ref.ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        allSources.push(ref);
      }
    }
  }
  return { title, items, sources: allSources, line_count: lines.length };
}
