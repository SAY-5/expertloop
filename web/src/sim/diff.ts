/**
 * Unified diff of two line arrays with three lines of context, matching the shape of
 * Python's difflib.unified_diff output used by the service for edit rows.
 */

export interface DiffLine {
  kind: "context" | "add" | "remove" | "header" | "hunk";
  text: string;
}

type Op = { type: "equal" | "insert" | "delete"; a?: number; b?: number };

function lcsOps(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const table: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: "equal", a: i, b: j });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: "delete", a: i });
      i++;
    } else {
      ops.push({ type: "insert", b: j });
      j++;
    }
  }
  while (i < n) ops.push({ type: "delete", a: i++ });
  while (j < m) ops.push({ type: "insert", b: j++ });
  return ops;
}

export function unifiedDiff(before: string[], after: string[], fromFile = "before", toFile = "after", context = 3): string {
  const ops = lcsOps(before, after);
  if (ops.every((op) => op.type === "equal")) return "";
  const out: string[] = [`--- ${fromFile}`, `+++ ${toFile}`];

  const changed = ops.map((op) => op.type !== "equal");
  let index = 0;
  while (index < ops.length) {
    if (!changed[index]) {
      index++;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    while (end < ops.length) {
      if (changed[end]) {
        end++;
        continue;
      }
      let lookahead = end;
      while (lookahead < ops.length && !changed[lookahead] && lookahead - end < context * 2) lookahead++;
      if (lookahead < ops.length && changed[lookahead]) {
        end = lookahead;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    const slice = ops.slice(start, stop);
    const aStart = (slice.find((op) => op.a !== undefined)?.a ?? 0) + 1;
    const bStart = (slice.find((op) => op.b !== undefined)?.b ?? 0) + 1;
    const aCount = slice.filter((op) => op.a !== undefined).length;
    const bCount = slice.filter((op) => op.b !== undefined).length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) {
      if (op.type === "equal") out.push(` ${before[op.a!]}`);
      else if (op.type === "delete") out.push(`-${before[op.a!]}`);
      else out.push(`+${after[op.b!]}`);
    }
    index = stop;
  }
  return out.join("\n");
}

/** Canonical JSON with sorted keys and two-space indentation, mirroring json.dumps(sort_keys=True, indent=2). */
export function canonicalPretty(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

/** Compact canonical JSON with sorted keys, mirroring json.dumps(sort_keys=True, separators=(",", ":")). */
export function canonicalCompact(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeys(v);
    return out;
  }
  return value;
}

export function diffDocuments(oldDoc: unknown, newDoc: unknown): string {
  return unifiedDiff(canonicalPretty(oldDoc).split("\n"), canonicalPretty(newDoc).split("\n"));
}

export function parseDiff(diff: string): DiffLine[] {
  return diff
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return { kind: "header", text: line };
      if (line.startsWith("@@")) return { kind: "hunk", text: line };
      if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
      if (line.startsWith("-")) return { kind: "remove", text: line.slice(1) };
      return { kind: "context", text: line.slice(1) };
    });
}
