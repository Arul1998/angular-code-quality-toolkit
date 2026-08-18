import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPackageManager,
  binRunner,
  scriptRunner,
  scriptCommand,
  addDevCommand,
  LockfilePresence,
} from '../packageManager';

const none: LockfilePresence = { npm: false, yarn: false, pnpm: false, bun: false };

test('detectPackageManager defaults to npm when nothing distinctive is present', () => {
  assert.equal(detectPackageManager(none), 'npm');
  assert.equal(detectPackageManager({ ...none, npm: true }), 'npm');
});

test('detectPackageManager recognizes each lockfile', () => {
  assert.equal(detectPackageManager({ ...none, yarn: true }), 'yarn');
  assert.equal(detectPackageManager({ ...none, pnpm: true }), 'pnpm');
  assert.equal(detectPackageManager({ ...none, bun: true }), 'bun');
});

test('detectPackageManager prefers specific managers over npm when several exist', () => {
  assert.equal(detectPackageManager({ npm: true, yarn: true, pnpm: true, bun: true }), 'pnpm');
  assert.equal(detectPackageManager({ ...none, npm: true, yarn: true }), 'yarn');
  assert.equal(detectPackageManager({ ...none, npm: true, bun: true }), 'bun');
});

test('binRunner maps to the local-binary runner per manager', () => {
  assert.equal(binRunner('npm'), 'npx --yes');
  assert.equal(binRunner('pnpm'), 'pnpm exec');
  assert.equal(binRunner('yarn'), 'yarn exec');
  assert.equal(binRunner('bun'), 'bunx');
});

test('scriptRunner maps to the script runner per manager', () => {
  assert.equal(scriptRunner('npm'), 'npm run');
  assert.equal(scriptRunner('pnpm'), 'pnpm run');
  assert.equal(scriptRunner('yarn'), 'yarn run');
  assert.equal(scriptRunner('bun'), 'bun run');
});

test('scriptCommand forwards args after --', () => {
  assert.equal(scriptCommand('npm', 'lint'), 'npm run lint');
  assert.equal(scriptCommand('npm', 'lint', '--format json'), 'npm run lint -- --format json');
  assert.equal(scriptCommand('pnpm', 'lint', '--format json'), 'pnpm run lint -- --format json');
});

test('addDevCommand builds the right install hint per manager', () => {
  assert.equal(addDevCommand('npm', 'depcheck'), 'npm install --save-dev depcheck');
  assert.equal(addDevCommand('yarn', 'depcheck'), 'yarn add --dev depcheck');
  assert.equal(addDevCommand('pnpm', 'depcheck'), 'pnpm add --save-dev depcheck');
  assert.equal(addDevCommand('bun', 'depcheck'), 'bun add --dev depcheck');
});
