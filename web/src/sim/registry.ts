/**
 * Source registry (port of expertloop/sources/registry.py): referenced documents, tickets and
 * URLs with content hashes. A citation stores the source's hash at compile or edit time;
 * verification compares it with the registry's current hash so a changed policy document shows
 * up as an unverified citation instead of silently drifting.
 */

import { type Citation, type InstructionDocument } from "./compile";
import { sha256 } from "./sha256";

export interface Source {
  id: number;
  kind: string;
  ref: string;
  title: string | null;
  content: string | null;
  content_hash: string;
}

export interface CitationReport extends Citation {
  section: string;
  entry: string;
  verified: boolean;
}

export function contentHash(content: string | null, ref: string): string {
  return sha256(content !== null ? content : `ref:${ref}`);
}

export class SourceRegistry {
  private sources: Source[] = [];
  private nextId = 1;

  list(): Source[] {
    return this.sources.slice();
  }

  find(kind: string, ref: string): Source | undefined {
    return this.sources.find((s) => s.kind === kind && s.ref === ref);
  }

  byId(id: number): Source | undefined {
    return this.sources.find((s) => s.id === id);
  }

  register(kind: string, ref: string, content: string | null = null, title: string | null = null): Source {
    const existing = this.find(kind, ref);
    if (existing) {
      if (content !== null && content !== existing.content) {
        existing.content = content;
        existing.content_hash = contentHash(content, ref);
      }
      if (title !== null) existing.title = title;
      return existing;
    }
    const source: Source = {
      id: this.nextId++,
      kind,
      ref,
      title,
      content,
      content_hash: contentHash(content, ref),
    };
    this.sources.push(source);
    return source;
  }

  /**
   * Attach source_id and source_hash to every citation with a source reference. Unknown sources
   * are registered with the reference itself as the hashed payload so the link is always
   * resolvable. Returns the number of distinct sources linked.
   */
  resolveCitations(document: InstructionDocument): number {
    const linked = new Set<number>();
    for (const cite of iterCitations(document)) {
      const ref = cite.source_ref;
      if (!ref) continue;
      const source = this.register(cite.source_kind ?? "doc", ref);
      cite.source_id = source.id;
      cite.source_hash = source.content_hash;
      linked.add(source.id);
    }
    return linked.size;
  }

  /** Return a verification report for every citation in the document. */
  verifyCitations(document: InstructionDocument): CitationReport[] {
    const report: CitationReport[] = [];
    for (const key of SECTION_KEYS) {
      for (const entry of document[key] as Array<{ id?: string; text?: string; condition?: string; citations?: Citation[] }>) {
        for (const cite of entry.citations ?? []) {
          const row: CitationReport = {
            ...cite,
            section: key,
            entry: entry.id ?? entry.text ?? entry.condition ?? "",
            verified: true,
          };
          if (cite.source_id) {
            const source = this.byId(cite.source_id);
            row.verified = Boolean(source && source.content_hash === cite.source_hash);
          }
          report.push(row);
        }
      }
    }
    return report;
  }
}

const SECTION_KEYS = ["preconditions", "steps", "decision_rules", "forbidden_actions", "outcomes"] as const;

export function* iterCitations(document: InstructionDocument): Generator<Citation> {
  for (const key of SECTION_KEYS) {
    for (const entry of document[key] as Array<{ citations?: Citation[] }>) {
      for (const cite of entry.citations ?? []) yield cite;
    }
  }
}
