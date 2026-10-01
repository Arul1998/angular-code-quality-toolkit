import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendHistory,
  escapeHtml,
  healthGrade,
  healthScore,
  renderHealthHtml,
  snapshotFindings,
  sparklinePoints,
  topFiles,
} from '../health';
import { ReportFinding } from '../report';

const finding = (tool: string, file: string, severity: ReportFinding['severity'] = 'warning'): ReportFinding => ({
  tool,
  file,
  line: 1,
  column: 1,
  severity,
  message: 'm',
});

test('healthScore is 100 when clean, halves at 50 weighted findings, weighs errors 3x', () => {
  assert.equal(healthScore(0, 0), 100);
  assert.equal(healthScore(0, 50), 50);
  assert.equal(healthScore(10, 20), 50);
  assert.equal(healthScore(1, 0), healthScore(0, 3));
  assert.ok(healthScore(1, 0) < healthScore(0, 1));
  assert.ok(healthScore(10000, 0) > 0);
});

test('healthGrade thresholds', () => {
  assert.deepEqual([95, 90, 80, 60, 45, 10].map(healthGrade), ['A', 'A', 'B', 'C', 'D', 'E']);
});

test('snapshotFindings totals by tool label and severity', () => {
  const snap = snapshotFindings(
    [finding('angular-quality-eslint', 'a', 'error'), finding('angular-quality-eslint', 'b'), finding('angular-quality-knip', 'a', 'info')],
    't',
    (source) => source.replace('angular-quality-', '')
  );
  assert.deepEqual(snap, { at: 't', total: 3, errors: 1, warnings: 2, byTool: { eslint: 2, knip: 1 } });
});

test('appendHistory keeps only the most recent entries', () => {
  const snap = (n: number) => ({ at: String(n), total: n, errors: 0, warnings: n, byTool: {} });
  const history = appendHistory([snap(1), snap(2), snap(3)], snap(4), 3);
  assert.deepEqual(history.map((h) => h.total), [2, 3, 4]);
});

test('topFiles orders by count then name', () => {
  const result = topFiles([finding('t', 'b'), finding('t', 'a'), finding('t', 'b'), finding('t', 'c')], 2);
  assert.deepEqual(result, [
    { file: 'b', count: 2 },
    { file: 'a', count: 1 },
  ]);
});

test('sparklinePoints scales totals into the box', () => {
  assert.equal(sparklinePoints([], 100, 10), '');
  assert.equal(sparklinePoints([5], 100, 10), '50,0');
  assert.equal(sparklinePoints([0, 10], 100, 10), '0,10 100,0');
});

test('renderHealthHtml escapes user content and shows score, trend and notes', () => {
  const current = { at: 'now', total: 2, errors: 1, warnings: 1, byTool: { '<ESLint>': 2 } };
  const html = renderHealthHtml(
    {
      title: 'my <app>',
      generatedAt: 'today',
      current,
      history: [{ at: 'before', total: 4, errors: 2, warnings: 2, byTool: { '<ESLint>': 4 } }],
      topFiles: [{ file: 'src/"x".ts', count: 2 }],
      baselineSuppressed: 3,
      changedFilesOnly: true,
    },
    { cspSource: 'vscode-resource:' }
  );
  assert.ok(html.includes('my &lt;app&gt;'));
  assert.ok(html.includes('&lt;ESLint&gt;'));
  assert.ok(html.includes('src/&quot;x&quot;.ts'));
  assert.ok(!html.includes('<ESLint>'));
  assert.ok(html.includes(`<b>${healthScore(1, 1)}</b>`));
  assert.ok(html.includes('since last run'));
  assert.ok(html.includes('<polyline'));
  assert.ok(html.includes('3 existing findings are hidden by the baseline.'));
  assert.ok(html.includes('Only files changed in git'));
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(!html.includes('<script'));
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
