// Line diff for failure output (golden files, rendered manifests), no dependency. Myers' O(ND)
// algorithm after trimming the common prefix and suffix; a very large difference falls back to
// "everything in between replaced", which is still a correct (if unminimal) diff.

export interface LineDiffOptions {
  /** unchanged lines shown around each change (default 3) */
  context?: number;
  /** header labels (default `expected` / `actual`) */
  labels?: { expected: string; actual: string };
}

type Kind = ' ' | '-' | '+';

interface Op {
  kind: Kind;
  line: string;
  /** 0-based index in the expected lines (next line for an insertion) */
  a: number;
  /** 0-based index in the actual lines (next line for a deletion) */
  b: number;
}

/** keeps the trace of the search at a few megabytes */
const MAX_EDIT_DISTANCE = 1000;

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** Shortest edit script from a to b, or null when it needs more than `limit` edits. */
function myers(a: readonly string[], b: readonly string[], limit: number): Kind[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, limit);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
      let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(n, m, trace, d, offset);
    }
  }
  return null;
}

/** trace[d] holds the furthest x per diagonal before round d. */
function backtrack(n: number, m: number, trace: readonly Int32Array[], rounds: number, offset: number): Kind[] {
  const script: Kind[] = [];
  let x = n;
  let y = m;
  for (let d = rounds; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      script.push(' ');
      x--;
      y--;
    }
    if (down) {
      script.push('+');
      y--;
    } else {
      script.push('-');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    script.push(' ');
    x--;
    y--;
  }
  return script.reverse();
}

function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const script: Kind[] = myers(midA, midB, MAX_EDIT_DISTANCE) ?? [...midA.map((): Kind => '-'), ...midB.map((): Kind => '+')];

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: ' ', line: a[i], a: i, b: i });
  let x = 0;
  let y = 0;
  for (const kind of script) {
    const at = { a: start + x, b: start + y };
    if (kind === '+') {
      ops.push({ kind, line: midB[y], ...at });
      y++;
    } else {
      ops.push({ kind, line: midA[x], ...at });
      x++;
      if (kind === ' ') y++;
    }
  }
  for (let i = 0; endA + i < a.length; i++) ops.push({ kind: ' ', line: a[endA + i], a: endA + i, b: endB + i });
  return ops;
}

/**
 * Unified diff of two texts split on `\n` ('' when they are equal). A difference in the final
 * newline shows as an added or removed empty last line.
 */
export function lineDiff(expected: string, actual: string, options: LineDiffOptions = {}): string {
  if (expected === actual) return '';
  const context = options.context ?? 3;
  const labels = options.labels ?? { expected: 'expected', actual: 'actual' };
  const ops = editScript(splitLines(expected), splitLines(actual));

  const out = [`--- ${labels.expected}`, `+++ ${labels.actual}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === ' ') {
      i++;
      continue;
    }
    // one hunk: this change, the changes that follow within 2 * context lines, context around them
    let last = i;
    for (let j = i + 1; j < ops.length && j - last <= 2 * context; j++) {
      if (ops[j].kind !== ' ') last = j;
    }
    const first = Math.max(0, i - context);
    const stop = Math.min(ops.length - 1, last + context);
    const hunk = ops.slice(first, stop + 1);
    const aCount = hunk.filter((op) => op.kind !== '+').length;
    const bCount = hunk.filter((op) => op.kind !== '-').length;
    // unified diff numbers lines from 1, and names the line before an empty range
    const aStart = aCount === 0 ? hunk[0].a : hunk[0].a + 1;
    const bStart = bCount === 0 ? hunk[0].b : hunk[0].b + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
    i = stop + 1;
  }
  return `${out.join('\n')}\n`;
}
