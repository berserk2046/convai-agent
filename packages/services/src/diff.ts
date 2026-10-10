/**
 * Line diff (longest common subsequence) for the template version view and the upgrade
 * flow (spec §10: "show a diff"). Templates are a few hundred lines, so the O(n·m) table
 * is small. Long unchanged runs are folded down to `context` lines around each change.
 */

export type DiffLine =
  { kind: "same" | "added" | "removed"; text: string } | { kind: "skip"; count: number };

export function diffLines(before: string, after: string, context = 3): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the LCS of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as Uint32Array;
    const below = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      lines.push({ kind: "added", text: b[j] ?? "" });
      j += 1;
    } else {
      lines.push({ kind: "removed", text: a[i] ?? "" });
      i += 1;
    }
  }
  return fold(lines, context);
}

export function hasChanges(lines: readonly DiffLine[]): boolean {
  return lines.some((l) => l.kind === "added" || l.kind === "removed");
}

function fold(lines: DiffLine[], context: number): DiffLine[] {
  const changed = lines.map((l) => l.kind !== "same");
  const keep = lines.map((_, k) => {
    for (let d = -context; d <= context; d += 1) if (changed[k + d]) return true;
    return false;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  for (const [k, line] of lines.entries()) {
    if (keep[k]) {
      if (skipped > 0) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(line);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}
