import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  resolveFilePath,
  parseDepcheckOutput,
  parseTsPruneOutput,
  parseEslintOutput,
  parseStylelintOutput,
  parseKnipOutput,
  parseMadgeOutput,
  matchesGlob,
  partitionUnusedDependencies,
  buildDiagnosticShape,
  appendRule,
  DIAGNOSTIC_SOURCES,
  SEVERITY_RANK,
  ANGULAR_IMPLICIT_PATTERNS,
  ParsedIssue,
  formatProblemSummary,
} from '../diagnostics';

const CWD = path.resolve('/project');

test('formatProblemSummary totals counts and builds a per-tool breakdown', () => {
  const s = formatProblemSummary([
    { label: 'ESLint', count: 3 },
    { label: 'stylelint', count: 1 },
    { label: 'ts-prune', count: 2 },
    { label: 'depcheck', count: 0 },
  ]);
  assert.equal(s.total, 6);
  assert.equal(s.text, 'Quality: 6');
  assert.equal(s.tooltip, 'ESLint: 3 · stylelint: 1 · ts-prune: 2 · depcheck: 0');
});

test('formatProblemSummary says "clean" when there are no problems', () => {
  const s = formatProblemSummary([
    { label: 'ESLint', count: 0 },
    { label: 'depcheck', count: 0 },
  ]);
  assert.equal(s.total, 0);
  assert.equal(s.text, 'Quality: clean');
  assert.equal(s.tooltip, 'ESLint: 0 · depcheck: 0');
});

test('resolveFilePath resolves relative paths against the project root', () => {
  assert.equal(resolveFilePath(CWD, 'src/app/foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));
  // Windows-style separators must resolve on every host (Linux CI included).
  assert.equal(resolveFilePath(CWD, 'src\\app\\foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));
  assert.equal(resolveFilePath(CWD, '\\src\\app\\foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));

  if (path.sep === '\\') {
    // On Windows a leading `/` is not a POSIX root; treat it as project-relative.
    assert.equal(resolveFilePath(CWD, '/src/app/foo.ts'), path.resolve(CWD, 'src/app/foo.ts'));
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
  assert.equal(lodash.severity, 'warning');
  assert.equal(lodash.file, path.join(CWD, 'package.json'));

  const missing = issues.find((i) => i.message.startsWith('Missing dependency'))!;
  assert.ok(missing.message.includes('rxjs'));
  assert.equal(missing.severity, 'warning');
  assert.equal(missing.file, path.resolve(CWD, 'src/app/app.component.ts'));
});

test('matchesGlob handles exact names and wildcards', () => {
  assert.equal(matchesGlob('zone.js', 'zone.js'), true);
  assert.equal(matchesGlob('@angular/core', '@angular/*'), true);
  assert.equal(matchesGlob('@angular/common/http', '@angular/*'), true);
  assert.equal(matchesGlob('@angular', '@angular/*'), false);
  assert.equal(matchesGlob('karma-chrome-launcher', 'karma-*'), true);
  assert.equal(matchesGlob('lodash', '@angular/*'), false);
});

test('partitionUnusedDependencies splits reported vs ignored', () => {
  const { reported, ignored } = partitionUnusedDependencies(
    ['lodash', '@angular/core', 'zone.js', 'moment'],
    [...ANGULAR_IMPLICIT_PATTERNS]
  );
  assert.deepEqual(reported.sort(), ['lodash', 'moment']);
  assert.deepEqual(ignored.sort(), ['@angular/core', 'zone.js']);
});

test('parseDepcheckOutput applies ignore patterns to unused deps but not missing', () => {
  const raw = JSON.stringify({
    dependencies: ['@angular/animations', 'lodash'],
    devDependencies: ['zone.js'],
    missing: { '@angular/router': ['src/app/app.module.ts'] },
  });
  const issues = parseDepcheckOutput(raw, CWD, path.join(CWD, 'package.json'), undefined, [
    '@angular/*',
    'zone.js',
  ]);
  const unused = issues.filter((i) => i.message.startsWith('Unused dependency'));
  assert.equal(unused.length, 1);
  assert.ok(unused[0].message.includes('lodash'));
  // Missing deps are never filtered.
  assert.ok(issues.some((i) => i.message.includes('Missing dependency: @angular/router')));
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
  assert.equal(issues[0].severity, 'warning');
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

test('appendRule adds the rule once, never doubling it', () => {
  // ESLint: message has no rule suffix → append normally.
  assert.equal(appendRule('x is unused', 'no-unused-vars'), 'x is unused (no-unused-vars)');
  // Modern stylelint: text already ends with the rule → do not double it.
  assert.equal(appendRule('Empty block (block-no-empty)', 'block-no-empty'), 'Empty block (block-no-empty)');
  // No rule id → message unchanged.
  assert.equal(appendRule('some message', null), 'some message');
  assert.equal(appendRule('some message', undefined), 'some message');
});

test('parseStylelintOutput does not double the rule when text already includes it', () => {
  const raw = JSON.stringify([
    {
      source: '/project/src/styles.scss',
      warnings: [
        { line: 5, column: 9, severity: 'error', text: 'Empty block (block-no-empty)', rule: 'block-no-empty' },
      ],
    },
  ]);
  const issues = parseStylelintOutput(raw, CWD);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].message, 'Empty block (block-no-empty)');
});

test('parseStylelintOutput falls back to compact text', () => {
  const raw = '/project/src/styles.scss:12:3: error Unexpected empty block (block-no-empty)';
  const issues = parseStylelintOutput(raw, CWD);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 11);
  assert.equal(issues[0].column, 2);
  assert.equal(issues[0].severity, 'error');
});

test('DIAGNOSTIC_SOURCES gives each tool its own Problems-panel source', () => {
  assert.equal(DIAGNOSTIC_SOURCES.eslint, 'angular-quality-eslint');
  assert.equal(DIAGNOSTIC_SOURCES.stylelint, 'angular-quality-stylelint');
  assert.equal(DIAGNOSTIC_SOURCES['ts-prune'], 'angular-quality-ts-prune');
  assert.equal(DIAGNOSTIC_SOURCES.depcheck, 'angular-quality-depcheck');
  assert.equal(DIAGNOSTIC_SOURCES.knip, 'angular-quality-knip');
  assert.equal(DIAGNOSTIC_SOURCES['angular-template'], 'angular-quality-template');
  assert.equal(DIAGNOSTIC_SOURCES.madge, 'angular-quality-madge');
});

test('parseKnipOutput reports unused files, exports, types, deps, unlisted, and enum members', () => {
  const raw = JSON.stringify({
    files: ['src/app/orphan.ts'],
    issues: [
      {
        file: 'src/app/foo.ts',
        exports: [{ name: 'unusedFn', line: 10, col: 14 }],
        types: [{ name: 'UnusedType', line: 12, col: 13 }],
        dependencies: ['lodash'],
        devDependencies: [{ name: 'jest', line: 1, col: 1 }],
        unlisted: [{ name: 'rxjs' }],
        enumMembers: { Color: [{ name: 'Red', line: 3, col: 5 }] },
      },
    ],
  });
  const issues = parseKnipOutput(raw, CWD);

  const unusedFile = issues.find((i) => i.message.startsWith('Unused file'))!;
  assert.ok(unusedFile);
  assert.equal(unusedFile.file, path.resolve(CWD, 'src/app/orphan.ts'));

  const exportIssue = issues.find((i) => i.message === 'Unused export: unusedFn')!;
  assert.ok(exportIssue);
  assert.equal(exportIssue.line, 9); // 1-based 10 → 0-based 9
  assert.equal(exportIssue.column, 13);
  assert.equal(exportIssue.file, path.resolve(CWD, 'src/app/foo.ts'));

  assert.ok(issues.some((i) => i.message === 'Unused type: UnusedType'));
  assert.ok(issues.some((i) => i.message === 'Unused dependency: lodash'));
  assert.ok(issues.some((i) => i.message === 'Unused dependency: jest'));
  assert.ok(issues.some((i) => i.message.startsWith('Unlisted dependency') && i.message.includes('rxjs')));
  assert.ok(issues.some((i) => i.message === 'Unused enum member: Color.Red'));
});

test('parseKnipOutput tolerates noise around the JSON and bad input', () => {
  const raw = 'npm warn exec\n' + JSON.stringify({ files: ['src/x.ts'], issues: [] });
  const issues = parseKnipOutput(raw, CWD);
  assert.equal(issues.length, 1);
  assert.equal(parseKnipOutput('not json at all', CWD).length, 0);
  assert.equal(parseKnipOutput('', CWD).length, 0);
});

test('parseMadgeOutput turns each cycle into one finding describing the loop', () => {
  const raw = JSON.stringify([
    ['src/a.ts', 'src/b.ts'],
    ['src/c.ts', 'src/d.ts', 'src/c.ts'],
  ]);
  const issues = parseMadgeOutput(raw, CWD);
  assert.equal(issues.length, 2);

  assert.equal(issues[0].file, path.resolve(CWD, 'src/a.ts'));
  // Loop is closed visually: a → b → a.
  assert.equal(issues[0].message, 'Circular dependency: src/a.ts → src/b.ts → src/a.ts');

  // madge already repeated the first file; don't double it.
  assert.equal(issues[1].message, 'Circular dependency: src/c.ts → src/d.ts → src/c.ts');
});

test('parseMadgeOutput returns nothing for a non-cycle object or bad input', () => {
  // A full dependency graph (object) is not a cycle list.
  assert.equal(parseMadgeOutput(JSON.stringify({ 'a.ts': ['b.ts'] }), CWD).length, 0);
  assert.equal(parseMadgeOutput('[]', CWD).length, 0);
  assert.equal(parseMadgeOutput('boom', CWD).length, 0);
});

test('SEVERITY_RANK mirrors vscode.DiagnosticSeverity numbering', () => {
  // Error=0, Warning=1, Information=2, Hint=3 (stable vscode API values).
  assert.equal(SEVERITY_RANK.error, 0);
  assert.equal(SEVERITY_RANK.warning, 1);
  assert.equal(SEVERITY_RANK.info, 2);
  assert.equal(SEVERITY_RANK.hint, 3);
});

test('buildDiagnosticShape assigns the tool source and correct severity/range', () => {
  const issue: ParsedIssue = {
    file: path.join(CWD, 'src/app/app.component.ts'),
    line: 23,
    column: 9,
    endColumn: 15,
    message: "'result' is assigned a value but never used.",
    severity: 'error',
  };
  const shape = buildDiagnosticShape(issue, 'eslint');
  assert.equal(shape.source, 'angular-quality-eslint');
  assert.equal(shape.severityRank, SEVERITY_RANK.error);
  assert.equal(shape.startLine, 23);
  assert.equal(shape.endLine, 23);
  assert.equal(shape.startColumn, 9);
  assert.equal(shape.endColumn, 15);
  assert.equal(shape.file, issue.file);
  assert.equal(shape.message, issue.message);
});

test('buildDiagnosticShape defaults end column to a non-empty range', () => {
  const issue: ParsedIssue = {
    file: path.join(CWD, 'package.json'),
    line: 4,
    column: 2,
    message: 'Unused dependency: lodash',
    severity: 'warning',
  };
  const shape = buildDiagnosticShape(issue, 'depcheck');
  assert.equal(shape.source, 'angular-quality-depcheck');
  assert.equal(shape.severityRank, SEVERITY_RANK.warning);
  // No endColumn given → range is at least one column wide.
  assert.equal(shape.endColumn, shape.startColumn + 1);
});

test('buildDiagnosticShape clamps malformed negative/inverted positions', () => {
  const issue: ParsedIssue = {
    file: path.join(CWD, 'src/broken.ts'),
    line: -5,
    column: -3,
    endColumn: -10, // inverted/negative end column from garbage output
    message: 'garbage',
    severity: 'hint',
  };
  const shape = buildDiagnosticShape(issue, 'ts-prune');
  assert.equal(shape.startLine, 0);
  assert.equal(shape.startColumn, 0);
  assert.equal(shape.endColumn, 1); // never negative, never inverted
  assert.equal(shape.severityRank, SEVERITY_RANK.hint);
});

test('buildDiagnosticShape falls back to Warning for an unknown severity', () => {
  const issue = {
    file: path.join(CWD, 'src/x.ts'),
    line: 0,
    column: 0,
    message: 'x',
    severity: 'bogus',
  } as unknown as ParsedIssue;
  const shape = buildDiagnosticShape(issue, 'stylelint');
  assert.equal(shape.severityRank, SEVERITY_RANK.warning);
});
