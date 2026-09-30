import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { ToolKey } from '../diagnostics';
import {
  TOOLS,
  TOOL_KEYS,
  InstallState,
  detectInstallState,
  getTool,
  isToolKey,
  missingRecommended,
  selectChecks,
} from '../tools';

const root = path.resolve('/repo');

/** exists() backed by a set of absolute paths. */
function fsWith(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

function states(map: Partial<Record<ToolKey, InstallState>>, fallback: InstallState = 'missing') {
  return (key: ToolKey): InstallState => map[key] ?? fallback;
}

test('TOOLS has a unique entry for every tool key', () => {
  assert.equal(new Set(TOOL_KEYS).size, TOOLS.length);
  for (const key of TOOL_KEYS) {
    assert.equal(getTool(key).key, key);
  }
  assert.ok(isToolKey('knip'));
  assert.ok(!isToolKey('prettier'));
  assert.ok(!isToolKey(42));
});

test('detectInstallState finds a package in the project node_modules', () => {
  const exists = fsWith(
    path.join(root, 'node_modules'),
    path.join(root, 'node_modules', 'knip', 'package.json')
  );
  assert.equal(detectInstallState(root, 'knip', exists), 'installed');
  assert.equal(detectInstallState(root, 'madge', exists), 'missing');
});

test('detectInstallState handles scoped packages and hoisted monorepo installs', () => {
  const exists = fsWith(
    path.join(root, 'node_modules'),
    path.join(root, 'node_modules', '@angular-eslint', 'template-parser', 'package.json')
  );
  const nested = path.join(root, 'apps', 'web');
  assert.equal(detectInstallState(nested, '@angular-eslint/template-parser', exists), 'installed');
});

test('detectInstallState is unknown without node_modules or under Yarn PnP', () => {
  assert.equal(detectInstallState(root, 'knip', fsWith()), 'unknown');
  const pnp = fsWith(path.join(root, '.pnp.cjs'), path.join(root, 'node_modules'));
  assert.equal(detectInstallState(root, 'knip', pnp), 'unknown');
});

test('selectChecks (auto) runs installed tools and lets knip replace ts-prune + depcheck', () => {
  const selection = selectChecks(
    [],
    states({ eslint: 'installed', stylelint: 'installed', knip: 'installed', 'ts-prune': 'installed', depcheck: 'installed' })
  );
  assert.deepEqual(selection.run, ['eslint', 'stylelint', 'knip']);
  assert.deepEqual(selection.skipped, [
    { key: 'ts-prune', reason: 'covered-by-knip' },
    { key: 'depcheck', reason: 'covered-by-knip' },
  ]);
});

test('selectChecks (auto) keeps the legacy tools when knip is not installed', () => {
  const selection = selectChecks(
    [],
    states({ eslint: 'installed', stylelint: 'installed', 'ts-prune': 'installed', depcheck: 'installed' })
  );
  assert.deepEqual(selection.run, ['eslint', 'stylelint', 'ts-prune', 'depcheck']);
  // knip isn't nagged about: ts-prune/depcheck already cover unused code.
  assert.deepEqual(selection.skipped, []);
});

test('selectChecks (auto) reports missing core tools and includes madge when installed', () => {
  const selection = selectChecks([], states({ eslint: 'installed', madge: 'installed' }));
  assert.deepEqual(selection.run, ['eslint', 'madge']);
  assert.deepEqual(selection.skipped, [
    { key: 'stylelint', reason: 'not-installed' },
    { key: 'knip', reason: 'not-installed' },
  ]);
});

test('selectChecks (auto) never picks template lint on its own', () => {
  const selection = selectChecks([], states({}, 'installed'));
  assert.ok(!selection.run.includes('angular-template'));
});

test('selectChecks (auto) falls back to the classic four when installs are unknown (PnP)', () => {
  const selection = selectChecks([], states({}, 'unknown'));
  assert.deepEqual(selection.run, ['eslint', 'stylelint', 'ts-prune', 'depcheck']);
  assert.deepEqual(selection.skipped, []);
});

test('selectChecks (explicit) runs exactly the configured tools, skipping missing ones', () => {
  const selection = selectChecks(
    ['madge', 'angular-template', 'eslint', 'bogus'],
    states({ eslint: 'installed', 'angular-template': 'unknown' })
  );
  assert.deepEqual(selection.run, ['eslint', 'angular-template']);
  assert.deepEqual(selection.skipped, [{ key: 'madge', reason: 'not-installed' }]);
});

test('missingRecommended lists only recommended tools that are definitely missing', () => {
  assert.deepEqual(
    missingRecommended(states({ eslint: 'installed', stylelint: 'unknown' })),
    ['knip']
  );
});
