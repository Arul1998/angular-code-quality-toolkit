import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunRegistry } from '../runRegistry';

test('a new run for the same key cancels and supersedes the old one', () => {
  const registry = new RunRegistry();
  let firstCanceled = false;
  const first = registry.begin('app|eslint', () => (firstCanceled = true));
  assert.ok(first.isCurrent());

  const second = registry.begin('app|eslint', () => undefined);
  assert.ok(firstCanceled);
  assert.ok(!first.isCurrent());
  assert.ok(second.isCurrent());

  // The superseded run finishing must not clear the newer run.
  first.end();
  assert.ok(registry.isRunning('app|eslint'));
  second.end();
  assert.ok(!registry.isRunning('app|eslint'));
});

test('runs for different keys are independent', () => {
  const registry = new RunRegistry();
  let canceled = false;
  const eslint = registry.begin('app|eslint', () => (canceled = true));
  registry.begin('app|stylelint', () => undefined);
  registry.begin('other|eslint', () => undefined);
  assert.ok(!canceled);
  assert.ok(eslint.isCurrent());
});

test('cancelAll cancels every in-flight run', () => {
  const registry = new RunRegistry();
  const canceled: string[] = [];
  registry.begin('a', () => canceled.push('a'));
  registry.begin('b', () => canceled.push('b'));
  registry.cancelAll();
  assert.deepEqual(canceled.sort(), ['a', 'b']);
  assert.ok(!registry.isRunning('a'));
});
