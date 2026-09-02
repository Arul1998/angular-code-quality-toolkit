import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, summarizeFindings, ReportFinding } from '../report';

const FINDINGS: ReportFinding[] = [
  {
    tool: 'angular-quality-eslint',
    file: 'src/b.ts',
    line: 10,
    column: 5,
    severity: 'error',
    message: 'x is unused',
  },
  {
    tool: 'angular-quality-eslint',
    file: 'src/a.ts',
    line: 2,
    column: 1,
    severity: 'warning',
    message: 'prefer const',
  },
  {
    tool: 'angular-quality-depcheck',
    file: 'package.json',
    line: 4,
    column: 1,
    severity: 'warning',
    message: 'Unused dependency: lodash',
  },
];

test('summarizeFindings rolls up totals by severity and tool', () => {
  const summary = summarizeFindings(FINDINGS);
  assert.equal(summary.total, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.warnings, 2);
  assert.deepEqual(summary.byTool, {
    'angular-quality-eslint': 2,
    'angular-quality-depcheck': 1,
  });
});

test('summarizeFindings handles an empty set', () => {
  const summary = summarizeFindings([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.errors, 0);
  assert.equal(summary.warnings, 0);
  assert.deepEqual(summary.byTool, {});
});

test('buildReport is deterministic: sorted findings and injected metadata', () => {
  const report = buildReport(FINDINGS, {
    version: '0.7.0',
    generatedAt: '2026-09-02T00:00:00.000Z',
  });
  assert.equal(report.tool, 'angular-code-quality-toolkit');
  assert.equal(report.version, '0.7.0');
  assert.equal(report.generatedAt, '2026-09-02T00:00:00.000Z');
  assert.equal(report.summary.total, 3);

  // Sorted by file, then line, then column — so package.json < src/a.ts < src/b.ts.
  assert.deepEqual(
    report.findings.map((f) => f.file),
    ['package.json', 'src/a.ts', 'src/b.ts']
  );
});

test('buildReport does not mutate the input array', () => {
  const input = [...FINDINGS];
  const firstBefore = input[0].file;
  buildReport(input, { version: '1.0.0', generatedAt: 'now' });
  assert.equal(input[0].file, firstBefore);
});
