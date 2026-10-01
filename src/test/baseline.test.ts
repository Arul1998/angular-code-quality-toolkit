import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaseline, buildBaseline, parseBaseline } from '../baseline';

const f = (tool: string, file: string, message: string) => ({ tool, file, message });

test('buildBaseline counts duplicates and sorts entries', () => {
  const baseline = buildBaseline(
    [f('eslint', 'src/b.ts', 'x'), f('eslint', 'src/a.ts', 'y'), f('eslint', 'src/b.ts', 'x')],
    '2026-09-30T00:00:00.000Z'
  );
  assert.deepEqual(baseline, {
    version: 1,
    createdAt: '2026-09-30T00:00:00.000Z',
    entries: [
      { tool: 'eslint', file: 'src/a.ts', message: 'y', count: 1 },
      { tool: 'eslint', file: 'src/b.ts', message: 'x', count: 2 },
    ],
  });
});

test('applyBaseline hides baselined findings and keeps new ones (multiset)', () => {
  const baseline = buildBaseline([f('eslint', 'a.ts', 'x'), f('eslint', 'a.ts', 'x')], 't');
  const current = [
    f('eslint', 'a.ts', 'x'),
    f('eslint', 'a.ts', 'x'),
    f('eslint', 'a.ts', 'x'), // a third identical one is new
    f('eslint', 'a.ts', 'new problem'),
    f('stylelint', 'a.ts', 'x'), // same message, other tool: new
  ];
  const { kept, suppressed } = applyBaseline(current, (i) => i, baseline);
  assert.equal(suppressed, 2);
  assert.deepEqual(kept, [f('eslint', 'a.ts', 'x'), f('eslint', 'a.ts', 'new problem'), f('stylelint', 'a.ts', 'x')]);
});

test('parseBaseline round-trips and rejects junk', () => {
  const baseline = buildBaseline([f('knip', 'src/x.ts', 'Unused export: a')], 't');
  assert.deepEqual(parseBaseline(JSON.stringify(baseline)), baseline);
  assert.equal(parseBaseline('not json'), null);
  assert.equal(parseBaseline('{"version":2,"entries":[]}'), null);
  assert.deepEqual(parseBaseline('{"version":1,"entries":[{"tool":"a"},{"tool":"a","file":"b","message":"c"}]}'), {
    version: 1,
    createdAt: '',
    entries: [{ tool: 'a', file: 'b', message: 'c', count: 1 }],
  });
});
