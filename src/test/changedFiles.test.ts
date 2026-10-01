import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { changedFilesGitCommands, filterToChangedFiles, parseGitPaths, pathKey } from '../changedFiles';

const repo = path.resolve('/repo');

test('changedFilesGitCommands adds the branch diff only when a base ref is set', () => {
  assert.equal(changedFilesGitCommands('').length, 2);
  const withBase = changedFilesGitCommands(' origin/main ');
  assert.deepEqual(withBase[2], ['diff', '--name-only', 'origin/main...HEAD']);
});

test('parseGitPaths resolves repo-relative lines and skips blanks', () => {
  assert.deepEqual(parseGitPaths('src/a.ts\r\n\n  src/b.html  \n', repo), [
    path.join(repo, 'src', 'a.ts'),
    path.join(repo, 'src', 'b.html'),
  ]);
});

test('filterToChangedFiles keeps findings in changed files only', () => {
  const changed = new Set([pathKey(path.join(repo, 'src', 'A.ts'), true)]);
  const items = [
    { file: path.join(repo, 'src', 'a.ts'), id: 1 },
    { file: path.join(repo, 'src', 'b.ts'), id: 2 },
  ];
  const insensitive = filterToChangedFiles(items, changed, true);
  assert.deepEqual(insensitive.kept.map((i) => i.id), [1]);
  assert.equal(insensitive.hidden, 1);

  const sensitive = filterToChangedFiles(items, new Set([pathKey(path.join(repo, 'src', 'A.ts'), false)]), false);
  assert.deepEqual(sensitive.kept, []);
});
