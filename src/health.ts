/**
 * Health report: a single score for the project, a trend across runs, and an
 * HTML page (shown in a webview, or exported as a file). Pure and vscode-free so
 * the scoring and rendering are unit-tested.
 */

import { ReportFinding } from './report';

/** Totals from one completed "Run all checks", kept per folder to show a trend. */
export interface HealthSnapshot {
  /** ISO timestamp. */
  at: string;
  total: number;
  errors: number;
  warnings: number;
  /** Findings per tool label. */
  byTool: Record<string, number>;
}

/**
 * 0–100, higher is better. Errors weigh 3× warnings. The curve halves the score
 * at 50 weighted findings (e.g. 50 warnings, or 10 errors + 20 warnings) and
 * bottoms out at 1, never 0, so progress is always visible.
 */
export function healthScore(errors: number, warnings: number): number {
  const weighted = Math.max(0, errors) * 3 + Math.max(0, warnings);
  return Math.max(1, Math.round(100 / (1 + weighted / 50)));
}

export function healthGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (score >= 90) {
    return 'A';
  }
  if (score >= 75) {
    return 'B';
  }
  if (score >= 60) {
    return 'C';
  }
  if (score >= 40) {
    return 'D';
  }
  return 'E';
}

/** Snapshot the current findings; `toolLabel` maps a finding's `tool` source to a display label. */
export function snapshotFindings(
  findings: readonly ReportFinding[],
  at: string,
  toolLabel: (source: string) => string
): HealthSnapshot {
  const byTool: Record<string, number> = {};
  let errors = 0;
  for (const f of findings) {
    const label = toolLabel(f.tool);
    byTool[label] = (byTool[label] ?? 0) + 1;
    if (f.severity === 'error') {
      errors++;
    }
  }
  return { at, total: findings.length, errors, warnings: findings.length - errors, byTool };
}

/** Append a snapshot, keeping the most recent `max`. */
export function appendHistory(
  history: readonly HealthSnapshot[],
  snapshot: HealthSnapshot,
  max = 30
): HealthSnapshot[] {
  return [...history, snapshot].slice(-max);
}

/** The files with the most findings, most first (ties by name). */
export function topFiles(findings: readonly ReportFinding[], limit = 10): { file: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.file, (counts.get(f.file) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, limit);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface HealthReportData {
  /** Heading, e.g. the folder or Angular project name. */
  title: string;
  generatedAt: string;
  current: HealthSnapshot;
  /** Earlier snapshots (oldest first), not including `current`. */
  history: readonly HealthSnapshot[];
  topFiles: readonly { file: string; count: number }[];
  /** Findings hidden by the baseline, if one is active. */
  baselineSuppressed?: number;
  /** True when only changed files are being shown. */
  changedFilesOnly?: boolean;
}

/** Polyline points for a small trend chart of totals (oldest → newest). */
export function sparklinePoints(totals: readonly number[], width: number, height: number): string {
  if (totals.length === 0) {
    return '';
  }
  const max = Math.max(1, ...totals);
  const step = totals.length > 1 ? width / (totals.length - 1) : 0;
  return totals
    .map((t, i) => {
      const x = totals.length > 1 ? i * step : width / 2;
      const y = height - (t / max) * height;
      return `${round1(x)},${round1(y)}`;
    })
    .join(' ');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function deltaText(current: number, previous: number | undefined, lowerIsBetter: boolean): string {
  if (previous === undefined) {
    return '';
  }
  const diff = current - previous;
  if (diff === 0) {
    return '<span class="delta same">no change</span>';
  }
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  const sign = diff > 0 ? '+' : '−';
  return `<span class="delta ${good ? 'good' : 'bad'}">${sign}${Math.abs(diff)} since last run</span>`;
}

/**
 * Render the report as a self-contained HTML page (no scripts, no external
 * resources). Colors use VS Code theme variables with light fallbacks, so the
 * same page works in a webview and as an exported file in a browser.
 */
export function renderHealthHtml(data: HealthReportData, options: { cspSource?: string } = {}): string {
  const { current } = data;
  const score = healthScore(current.errors, current.warnings);
  const grade = healthGrade(score);
  const previous = data.history.length > 0 ? data.history[data.history.length - 1] : undefined;
  const previousScore = previous ? healthScore(previous.errors, previous.warnings) : undefined;

  const toolRows = Object.entries(current.byTool)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => {
      const pct = current.total > 0 ? Math.round((count / current.total) * 100) : 0;
      const prev = previous?.byTool[label];
      return `<tr><td>${escapeHtml(label)}</td><td class="num">${count}</td><td class="bar"><span style="width:${pct}%"></span></td><td>${deltaText(count, prev, true)}</td></tr>`;
    })
    .join('');

  const fileRows = data.topFiles
    .map((f) => `<tr><td class="file">${escapeHtml(f.file)}</td><td class="num">${f.count}</td></tr>`)
    .join('');

  const totals = [...data.history.map((h) => h.total), current.total];
  const chart =
    totals.length > 1
      ? `<section><h2>Trend (last ${totals.length} runs)</h2><svg class="trend" viewBox="-4 -4 408 88" role="img" aria-label="Total findings per run"><polyline points="${sparklinePoints(totals, 400, 80)}"/></svg></section>`
      : '';

  const notes: string[] = [];
  if (data.baselineSuppressed) {
    notes.push(`${data.baselineSuppressed} existing finding${data.baselineSuppressed === 1 ? ' is' : 's are'} hidden by the baseline.`);
  }
  if (data.changedFilesOnly) {
    notes.push('Only files changed in git are included.');
  }

  const csp = options.cspSource !== undefined
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${options.cspSource}; img-src ${options.cspSource} data:;">`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code health — ${escapeHtml(data.title)}</title>
<style>
  :root { --fg: var(--vscode-foreground, #1f2328); --muted: var(--vscode-descriptionForeground, #656d76);
    --bg: var(--vscode-editor-background, #ffffff); --border: var(--vscode-panel-border, #d0d7de);
    --accent: var(--vscode-charts-blue, #0969da); --good: var(--vscode-charts-green, #1a7f37); --bad: var(--vscode-charts-red, #cf222e); }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--fg); background: var(--bg); margin: 0; padding: 24px; max-width: 880px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .meta { color: var(--muted); font-size: 12px; }
  .score { display: flex; align-items: center; gap: 20px; margin-top: 20px; }
  .ring { width: 92px; height: 92px; border-radius: 50%; display: grid; place-items: center; font-size: 30px; font-weight: 600; border: 6px solid var(--accent); }
  .grade-A, .grade-B { border-color: var(--good); } .grade-D, .grade-E { border-color: var(--bad); }
  .stats { display: flex; gap: 24px; } .stat b { display: block; font-size: 22px; } .stat span { color: var(--muted); font-size: 12px; }
  table { border-collapse: collapse; width: 100%; } td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .num { text-align: right; font-variant-numeric: tabular-nums; width: 60px; } .file { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; word-break: break-all; }
  .bar { width: 40%; } .bar span { display: block; height: 8px; border-radius: 4px; background: var(--accent); min-width: 2px; }
  .delta { font-size: 12px; } .delta.good { color: var(--good); } .delta.bad { color: var(--bad); } .delta.same { color: var(--muted); }
  .trend { width: 100%; height: 90px; } .trend polyline { fill: none; stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .note { color: var(--muted); font-size: 12px; margin-top: 12px; } .empty { color: var(--muted); }
</style>
</head>
<body>
<h1>Code health — ${escapeHtml(data.title)}</h1>
<div class="meta">Generated ${escapeHtml(data.generatedAt)} by Angular Code Quality Toolkit</div>
<div class="score">
  <div class="ring grade-${grade}" title="Score ${score} / 100">${grade}</div>
  <div>
    <div class="stats">
      <div class="stat"><b>${score}</b><span>score / 100</span></div>
      <div class="stat"><b>${current.total}</b><span>findings</span></div>
      <div class="stat"><b>${current.errors}</b><span>errors</span></div>
      <div class="stat"><b>${current.warnings}</b><span>warnings &amp; info</span></div>
    </div>
    <div>${deltaText(score, previousScore, false)}</div>
  </div>
</div>
${notes.map((n) => `<div class="note">${escapeHtml(n)}</div>`).join('\n')}
<section><h2>By tool</h2>${toolRows ? `<table>${toolRows}</table>` : '<p class="empty">No findings. Nice work.</p>'}</section>
${chart}
<section><h2>Files with the most findings</h2>${fileRows ? `<table>${fileRows}</table>` : '<p class="empty">None.</p>'}</section>
<p class="note">Score = 100 ÷ (1 + (3 × errors + warnings) ÷ 50). Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, E below.</p>
</body>
</html>
`;
}
