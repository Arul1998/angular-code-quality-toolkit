import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  resolveFilePath,
  parseDepcheckOutput,
  parseTsPruneOutput,
  parseEslintOutput,
  parseStylelintOutput,
} from '../diagnostics';

const CWD = path.resolve('/project');

test('resolveFilePath resolves relative paths against the project root', () => {
  assert.equal(resolveFilePath(CWD, 'src/app/foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));
  assert.equal(resolveFilePath(CWD, 'src\\app\\foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));

  if (path.sep === '\\') {
    // On Windows, bare-separator paths from CLIs are relative to the project root.
    assert.equal(resolveFilePath(CWD, '/src/app/foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));
    assert.equal(resolveFilePath(CWD, '\\src\\app\\foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));
    assert.equal(resolveFilePath(CWD, 'C:\\abs\\foo.ts'), path.normalize('C:\\abs\\foo.ts'));
  } else {
    // On POSIX a leading slash is a genuine absolute path and is kept as-is.
    assert.equal(resolveFilePath(CWD, '/abs/foo.ts'), '/abs/foo.ts');
  }
});

test('parseDepcheckOutput reports unused and missing dependencies', () => {
  const pkg = [
    '{',
    '  "dependencies": {',
    '    "lodash": "^4.0.0"',
    '  },',
    '  "devDependencies": {',
    '    "jest": "^29.0.0"',
    '  }',
    '}',
  ].join('\n');
  const raw = JSON.stringify({
    dependencies: ['lodash'],
    devDependencies: ['jest'],
    missing: { rxjs: ['src/app/app.component.ts'] },
  });

  const issues = parseDepcheckOutput(raw, CWD, path.join(CWD, 'package.json'), pkg);

  const unused = issues.filter((i) => i.message.startsWith('Unused dependency'));
  assert.equal(unused.length, 2);
  const lodash = unused.find((i) => i.message.includes('lodash'))!;
  assert.equal(lodash.line, 2); // 0-based line of "lodash" in the package.json above
  assert.equal(lodash.severity, 'info');

  const missing = issues.find((i) => i.message.startsWith('Missing dependency'))!;
  assert.ok(missing.message.includes('rxjs'));
  assert.equal(missing.severity, 'warning');
  assert.equal(missing.file, path.resolve(CWD, 'src/app/app.component.ts'));
});

test('parseDepcheckOutput ignores noise around the JSON', () => {
  const raw = 'npm warn exec something\n' + JSON.stringify({ dependencies: ['moment'] });
  const issues = parseDepcheckOutput(raw, CWD, path.join(CWD, 'package.json'));
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('moment'));
});

test('parseTsPruneOutput parses file:line - symbol and skips "used in module"', () => {
  const raw = [
    'src/app/util.ts:10 - helperFn',
    'src/app/model.ts:3 - Foo (used in module)',
  ].join('\n');
  const issues = parseTsPruneOutput(raw, CWD);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 9); // 0-based
  assert.ok(issues[0].message.includes('helperFn'));
});

test('parseTsPruneOutput ignores TypeScript compiler errors', () => {
  const raw = [
    "src/app/app.module.ts:1:1 - error TS2307: Cannot find module '@foo/bar'.",
    'src/app/util.ts:10 - helperFn',
  ].join('\n');
  const issues = parseTsPruneOutput(raw, CWD);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('helperFn'));
  assert.ok(!issues.some((i) => i.message.includes('TS2307')));
});

test('parseEslintOutput prefers JSON format', () => {
  const raw = JSON.stringify([
    {
      filePath: '/project/src/app/app.component.ts',
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: 'x is unused', line: 4, column: 7, endColumn: 8 },
        { ruleId: '@angular-eslint/prefer-standalone', severity: 1, message: 'prefer standalone', line: 1, column: 1 },
      ],
    },
  ]);
  const issues = parseEslintOutput(raw, CWD);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].severity, 'error');
  assert.ok(issues[0].message.includes('no-unused-vars'));
  assert.equal(issues[0].line, 3);
  assert.equal(issues[1].severity, 'warning');
});

test('parseEslintOutput falls back to stylish text', () => {
  const raw = [
    '/project/src/app/app.component.ts',
    '  4:7  error  x is unused  no-unused-vars',
    '  1:1  warning  prefer standalone  @angular-eslint/prefer-standalone',
  ].join('\n');
  const issues = parseEslintOutput(raw, CWD);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].line, 3);
  assert.equal(issues[0].column, 6);
});

test('parseStylelintOutput prefers JSON format', () => {
  const raw = JSON.stringify([
    {
      source: '/project/src/styles.scss',
      warnings: [
        { line: 12, column: 3, severity: 'error', text: 'Unexpected empty block', rule: 'block-no-empty' },
      ],
    },
  ]);
  const issues = parseStylelintOutput(raw, CWD);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].line, 11);
  assert.ok(issues[0].message.includes('block-no-empty'));
});

test('parseStylelintOutput falls back to compact text', () => {
  const raw = '/project/src/styles.scss:12:3: error Unexpected empty block (block-no-empty)';
  const issues = parseStylelintOutput(raw, CWD);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 11);
  assert.equal(issues[0].column, 2);
  assert.equal(issues[0].severity, 'error');
});
