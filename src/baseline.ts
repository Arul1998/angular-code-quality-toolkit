/**
 * Baseline mode: record today's findings in a committed file, then hide them on
 * later runs so only *new* problems show. Pure and vscode-free (unit-tested).
 *
 * Findings are matched by tool + file + message, not by line, so unrelated edits
 * that shift lines don't resurface baselined findings. Matching is a multiset: if
 * a file had 3 identical findings when the baseline was taken, a 4th is new.
 */

export const BASELINE_FILE = '.angular-code-quality-baseline.json';

/** What identifies a finding for baseline purposes. `file` is folder-relative, `/`-separated. */
export interface BaselineKey {
  tool: string;
  file: string;
  message: string;
}

export interface BaselineEntry extends BaselineKey {
  count: number;
}

export interface Baseline {
  version: 1;
  createdAt: string;
  entries: BaselineEntry[];
}

export function baselineKey(k: BaselineKey): string {
  return `${k.tool}\u0000${k.file}\u0000${k.message}`;
}

/** Build a baseline from the current findings; output is sorted so the file diffs cleanly. */
export function buildBaseline(findings: readonly BaselineKey[], createdAt: string): Baseline {
  const counts = new Map<string, BaselineEntry>();
  for (const f of findings) {
    const key = baselineKey(f);
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
    } else {
      counts.set(key, { tool: f.tool, file: f.file, message: f.message, count: 1 });
    }
  }
  const entries = [...counts.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.tool.localeCompare(b.tool) || a.message.localeCompare(b.message)
  );
  return { version: 1, createdAt, entries };
}

/** Parse a baseline file; returns null for anything that isn't a valid v1 baseline. */
export function parseBaseline(text: string): Baseline | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') {
    return null;
  }
  const raw = data as { version?: unknown; createdAt?: unknown; entries?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.entries)) {
    return null;
  }
  const entries: BaselineEntry[] = [];
  for (const e of raw.entries) {
    if (
      e &&
      typeof e === 'object' &&
      typeof e.tool === 'string' &&
      typeof e.file === 'string' &&
      typeof e.message === 'string'
    ) {
      const count = typeof e.count === 'number' && e.count > 0 ? Math.floor(e.count) : 1;
      entries.push({ tool: e.tool, file: e.file, message: e.message, count });
    }
  }
  return { version: 1, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '', entries };
}

/**
 * Split `items` into those not covered by the baseline (`kept`) and a count of
 * the ones it hides. Each baseline entry hides at most `count` matching items.
 */
export function applyBaseline<T>(
  items: readonly T[],
  keyOf: (item: T) => BaselineKey,
  baseline: Baseline
): { kept: T[]; suppressed: number } {
  const remaining = new Map<string, number>();
  for (const e of baseline.entries) {
    const key = baselineKey(e);
    remaining.set(key, (remaining.get(key) ?? 0) + e.count);
  }
  const kept: T[] = [];
  let suppressed = 0;
  for (const item of items) {
    const key = baselineKey(keyOf(item));
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      suppressed++;
    } else {
      kept.push(item);
    }
  }
  return { kept, suppressed };
}
