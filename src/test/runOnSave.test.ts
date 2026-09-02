import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsForSavedFile } from '../runOnSave';

test('toolsForSavedFile maps package.json to depcheck', () => {
  assert.deepEqual(toolsForSavedFile('/repo/package.json'), ['depcheck']);
  // nested package.json (monorepo) still maps by basename
  assert.deepEqual(toolsForSavedFile('/repo/apps/web/package.json'), ['depcheck']);
});

test('toolsForSavedFile maps .ts files to eslint + ts-prune', () => {
  assert.deepEqual(toolsForSavedFile('/repo/src/app/app.component.ts'), ['eslint', 'ts-prune']);
});

test('toolsForSavedFile maps .html files to the Angular template lint', () => {
  assert.deepEqual(toolsForSavedFile('/repo/src/app/app.component.html'), ['angular-template']);
});

test('toolsForSavedFile maps .css and .scss files to stylelint', () => {
  assert.deepEqual(toolsForSavedFile('/repo/src/styles.css'), ['stylelint']);
  assert.deepEqual(toolsForSavedFile('/repo/src/app/app.component.scss'), ['stylelint']);
});

test('toolsForSavedFile is case-insensitive on extension and name', () => {
  assert.deepEqual(toolsForSavedFile('/repo/Foo.TS'), ['eslint', 'ts-prune']);
  assert.deepEqual(toolsForSavedFile('/repo/Styles.SCSS'), ['stylelint']);
  assert.deepEqual(toolsForSavedFile('/repo/PACKAGE.JSON'), ['depcheck']);
  assert.deepEqual(toolsForSavedFile('/repo/App.HTML'), ['angular-template']);
});

test('toolsForSavedFile returns [] for files no tool handles', () => {
  assert.deepEqual(toolsForSavedFile('/repo/README.md'), []);
  assert.deepEqual(toolsForSavedFile('/repo/angular.json'), []);
});
