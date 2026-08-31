import * as path from 'path';

/**
 * This module is intentionally free of any `vscode` imports so that the parsers
 * are pure functions that can be unit-tested with plain Node. The extension host
 * (extension.ts) is responsible for turning these plain issues into
 * `vscode.Diagnostic`s.
 */

export type IssueSeverity = 'error' | 'warning' | 'info' | 'hint';

/** The tools this extension runs. Each owns its own diagnostic collection. */
export type ToolKey = 'depcheck' | 'ts-prune' | 'eslint' | 'stylelint';

/**
 * Human-readable diagnostic `source` shown next to each entry in the Problems
 * panel. Distinct per tool so the user can tell — and filter — which tool
 * produced each finding, and so this extension's diagnostics never get confused
 * with those from the ESLint/Angular Language Service extensions.
 */
export const DIAGNOSTIC_SOURCES: Record<ToolKey, string> = {
  eslint: 'angular-quality-eslint',
  stylelint: 'angular-quality-stylelint',
  'ts-prune': 'angular-quality-ts-prune',
  depcheck: 'angular-quality-depcheck',
};

export interface ParsedIssue {
  /** Absolute filesystem path of the file the issue belongs to. */
  file: string;
  /** Zero-based line number. */
  line: number;
  /** Zero-based column number. */
  column: number;
  /** Optional zero-based end column (used to size the squiggle). */
  endColumn?: number;
  message: string;
  severity: IssueSeverity;
}

/**
 * Numeric severity ranks that mirror `vscode.DiagnosticSeverity`
 * (Error=0, Warning=1, Information=2, Hint=3). Kept here — free of the vscode
 * import — so the diagnostic-creation logic can be unit-tested with plain Node;
 * extension.ts casts these directly onto the real enum.
 */
export const SEVERITY_RANK: Record<IssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/** vscode-free description of the diagnostic a `ParsedIssue` becomes. */
export interface DiagnosticShape {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
  severityRank: number;
  source: string;
}

/**
 * Pure computation of the diagnostic an issue maps to, independent of the vscode
 * API. extension.ts wraps the result into real `vscode.Diagnostic`/`Range`/`Uri`
 * objects. Positions are clamped so malformed parser output can never produce a
 * negative or inverted range (which vscode would reject).
 */
export function buildDiagnosticShape(issue: ParsedIssue, toolKey: ToolKey): DiagnosticShape {
  const startLine = Math.max(0, issue.line);
  const startColumn = Math.max(0, issue.column);
  const endColumn = Math.max(issue.endColumn ?? startColumn + 1, startColumn + 1);
  return {
    file: issue.file,
    startLine,
    startColumn,
    endLine: startLine,
    endColumn,
    message: issue.message,
    severityRank: SEVERITY_RANK[issue.severity] ?? SEVERITY_RANK.warning,
    source: DIAGNOSTIC_SOURCES[toolKey],
  };
}

/**
 * Format the status-bar problem summary from per-tool counts. Pure (no vscode)
 * so the wording is unit-tested; the caller supplies the codicon based on
 * severity and wires the result onto the real StatusBarItem.
 */
export function formatProblemSummary(
  perTool: { label: string; count: number }[]
): { total: number; text: string; tooltip: string } {
  const total = perTool.reduce((sum, t) => sum + t.count, 0);
  const text = total === 0 ? 'Quality: clean' : `Quality: ${total}`;
  const breakdown = perTool.map((t) => `${t.label}: ${t.count}`).join(' · ');
  return { total, text, tooltip: breakdown };
}

/**
 * Resolve a path emitted by a CLI (ts-prune/eslint/stylelint) to an absolute
 * filesystem path using the project root. Paths like `src/app/...` or
 * `\src\app\...` (no drive letter) are treated as relative to the project root so
 * the resulting path always points at the real file. Absolute paths are kept.
 */
export function resolveFilePath(projectRoot: string, filePart: string): string {
  const original = filePart.trim();

  // A path is only "truly absolute" when it carries a Windows drive letter, is a
  // UNC path, or is a POSIX root path on a POSIX host. A bare leading separator
  // (e.g. "\src\app\..." emitted by some CLIs on Windows) is treated as relative
  // to the project root so we always land on the real file.
  // Detect these on the original string — converting `\` to `/` on POSIX would
  // otherwise make a UNC path look like a POSIX absolute path.
  const hasDriveLetter = /^[A-Za-z]:[\\/]/.test(original);
  const isUnc = /^\\\\/.test(original);
  const isPosixRoot = path.sep === '/' && original.startsWith('/');

  // Normalize both separators to the host so Windows-style CLI output
  // (`src\app\foo.ts`) still resolves on POSIX CI and vice versa.
  const normalized = original.replace(/[/\\]/g, path.sep);

  if (hasDriveLetter || isUnc || isPosixRoot) {
    return path.normalize(normalized);
  }

  const relativeToRoot = normalized.replace(/^[/\\]+/, '');
  return path.resolve(projectRoot, relativeToRoot);
}

/**
 * Pull the first JSON value (object or array) out of a noisy string. npx and npm
 * frequently print notices/warnings around the JSON we actually want.
 */
function extractJson(raw: string): string | undefined {
  const firstBrace = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');
  let start = -1;
  let close = '}';
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    close = ']';
  } else if (firstBrace !== -1) {
    start = firstBrace;
  }
  if (start === -1) {
    return undefined;
  }
  const end = raw.lastIndexOf(close);
  if (end <= start) {
    return undefined;
  }
  return raw.slice(start, end + 1);
}

/**
 * Package-name patterns that Angular projects use implicitly, so depcheck's
 * "unused" report for them is almost always a false positive. `*` is a wildcard.
 */
export const ANGULAR_IMPLICIT_PATTERNS: readonly string[] = [
  '@angular/*',
  '@angular-devkit/*',
  '@angular-eslint/*',
  '@angular-builders/*',
  '@nx/*',
  '@nrwl/*',
  'zone.js',
  'rxjs',
  'tslib',
  'typescript',
  'ng-packagr',
  'karma',
  'karma-*',
  'jasmine-core',
  '@types/jasmine',
  'jest-preset-angular',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Append ` (ruleId)` to a message unless the tool already included it. Modern
 * stylelint suffixes its `text` with the rule (e.g. "Empty block (block-no-empty)"),
 * so blindly appending would double it; ESLint's `message` never includes the
 * rule, so it appends normally.
 */
export function appendRule(text: string, rule?: string | null): string {
  const trimmed = text.trim();
  if (!rule) {
    return trimmed;
  }
  return trimmed.endsWith(`(${rule})`) ? trimmed : `${trimmed} (${rule})`;
}

/** Match a package name against a glob-ish pattern where `*` matches any run of characters. */
export function matchesGlob(name: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(name);
}

/** Split depcheck's unused list into what to report vs. what to ignore. */
export function partitionUnusedDependencies(
  unused: string[],
  ignorePatterns: string[]
): { reported: string[]; ignored: string[] } {
  const reported: string[] = [];
  const ignored: string[] = [];
  for (const dep of unused) {
    if (ignorePatterns.some((p) => matchesGlob(dep, p))) {
      ignored.push(dep);
    } else {
      reported.push(dep);
    }
  }
  return { reported, ignored };
}

/** Find line number (0-based) in package.json where a dependency name appears. */
export function getPackageJsonLineForDependency(content: string, depName: string): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`"${depName}"`)) {
      return i;
    }
  }
  return 0;
}

/** Parse `depcheck --json` output into issues on package.json and using-files. */
export function parseDepcheckOutput(
  rawOutput: string,
  cwd: string,
  packageJsonPath: string,
  packageJsonContent?: string,
  ignorePatterns: string[] = []
): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  const json = extractJson(rawOutput);
  if (!json) {
    return issues;
  }

  let data: {
    dependencies?: string[];
    devDependencies?: string[];
    missing?: Record<string, string[]>;
  };
  try {
    data = JSON.parse(json);
  } catch {
    return issues;
  }

  const allUnused = [...(data.dependencies ?? []), ...(data.devDependencies ?? [])];
  const { reported: unused } = partitionUnusedDependencies(allUnused, ignorePatterns);
  for (const dep of unused) {
    const line = packageJsonContent
      ? getPackageJsonLineForDependency(packageJsonContent, dep)
      : 0;
    issues.push({
      file: packageJsonPath,
      line,
      column: 0,
      endColumn: 200,
      message: `Unused dependency: ${dep}`,
      severity: 'warning',
    });
  }

  const missing = data.missing ?? {};
  for (const [dep, files] of Object.entries(missing)) {
    const firstFile = Array.isArray(files) ? files[0] : (files as unknown as string);
    if (firstFile && typeof firstFile === 'string') {
      issues.push({
        file: resolveFilePath(cwd, firstFile),
        line: 0,
        column: 0,
        endColumn: 80,
        message: `Missing dependency: ${dep} (used here but not declared in package.json)`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

/**
 * Parse ts-prune output. Supports `file:line - symbol` and `file  symbol`.
 * Exports flagged `(used in module)` are only referenced internally and are not
 * truly dead, so they are skipped to avoid false positives.
 */
export function parseTsPruneOutput(rawOutput: string, cwd: string): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  const lines = rawOutput.split(/\r?\n/).filter((l) => l.trim());

  for (const line of lines) {
    if (line.includes('(used in module)')) {
      continue;
    }

    // Compiler/tool errors (e.g. "foo.ts:1:1 - error TS2307: ...") superficially
    // look like ts-prune's "file:line - symbol" format. Never treat them as
    // unused exports, otherwise a crash reads as a successful, empty result.
    if (/\b(error|warning)\s+TS\d+/i.test(line) || /:\s*(error|warning)\b/i.test(line)) {
      continue;
    }

    const matchWithLine = line.match(/^(.+?):(\d+)\s*-\s*(.+)$/);
    if (matchWithLine) {
      const [, filePart, lineStr, symbol] = matchWithLine;
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      issues.push({
        file: resolveFilePath(cwd, filePart!),
        line: lineNum,
        column: 0,
        endColumn: 100,
        message: `Unused export: ${symbol!.trim()}`,
        severity: 'warning',
      });
      continue;
    }

    const matchNoLine = line.match(/^(.+?)\s{2,}(.+)$/);
    if (matchNoLine) {
      const [, filePart, symbol] = matchNoLine;
      issues.push({
        file: resolveFilePath(cwd, filePart!),
        line: 0,
        column: 0,
        endColumn: 100,
        message: `Unused export: ${symbol!.trim()}`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

interface EslintJsonMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
  endColumn?: number;
}

interface EslintJsonFile {
  filePath?: string;
  messages?: EslintJsonMessage[];
}

/** Parse ESLint `--format json` output. Returns null when the text is not ESLint JSON. */
export function parseEslintJson(rawOutput: string, cwd: string): ParsedIssue[] | null {
  const json = extractJson(rawOutput);
  if (!json || !json.startsWith('[')) {
    return null;
  }

  let data: EslintJsonFile[];
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) {
    return null;
  }

  const issues: ParsedIssue[] = [];
  for (const fileResult of data) {
    if (!fileResult || typeof fileResult.filePath !== 'string') {
      continue;
    }
    const file = resolveFilePath(cwd, fileResult.filePath);
    for (const m of fileResult.messages ?? []) {
      const line = Math.max(0, (m.line ?? 1) - 1);
      const column = Math.max(0, (m.column ?? 1) - 1);
      const endColumn = m.endColumn ? Math.max(column + 1, m.endColumn - 1) : undefined;
      issues.push({
        file,
        line,
        column,
        endColumn,
        message: appendRule((m.message ?? '').trim(), m.ruleId),
        severity: m.severity === 2 ? 'error' : 'warning',
      });
    }
  }
  return issues;
}

/** Parse ESLint stylish/compact text output (fallback when JSON is unavailable). */
export function parseEslintText(rawOutput: string, cwd: string): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  const lines = rawOutput.split(/\r?\n/);
  let currentFile: string | null = null;

  for (const line of lines) {
    // Compact: file:line:col: message
    const unixMatch = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
    if (unixMatch) {
      const [, filePart, lineStr, colStr, message] = unixMatch;
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      issues.push({
        file: resolveFilePath(cwd, filePart!),
        line: lineNum,
        column: colNum,
        endColumn: Math.max(colNum + 1, 80),
        message: message!.trim(),
        severity: /\berror\b/i.test(message!) ? 'error' : 'warning',
      });
      continue;
    }

    // Stylish detail line: "  line:col  severity  message"
    const stylishMatch = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)$/);
    if (stylishMatch && currentFile) {
      const [, lineStr, colStr, sev, message] = stylishMatch;
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      issues.push({
        file: resolveFilePath(cwd, currentFile),
        line: lineNum,
        column: colNum,
        endColumn: Math.max(colNum + 1, 80),
        message: message.trim(),
        severity: sev === 'error' ? 'error' : 'warning',
      });
      continue;
    }

    // Stylish file header line.
    if (line.trim().length > 0 && !/^\s/.test(line)) {
      const filePart = line.trim();
      if (/\.(ts|tsx|js|jsx|mjs|cjs|html)$/i.test(filePart)) {
        currentFile = filePart;
      } else {
        currentFile = null;
      }
    }
  }
  return issues;
}

/** Parse ESLint output, preferring JSON and falling back to text. */
export function parseEslintOutput(rawOutput: string, cwd: string): ParsedIssue[] {
  const json = parseEslintJson(rawOutput, cwd);
  if (json !== null) {
    return json;
  }
  return parseEslintText(rawOutput, cwd);
}

interface StylelintJsonWarning {
  line?: number;
  column?: number;
  endColumn?: number;
  severity?: string;
  text?: string;
  rule?: string;
}

interface StylelintJsonFile {
  source?: string;
  warnings?: StylelintJsonWarning[];
}

/** Parse stylelint `--formatter json` output. Returns null when not stylelint JSON. */
export function parseStylelintJson(rawOutput: string, cwd: string): ParsedIssue[] | null {
  const json = extractJson(rawOutput);
  if (!json || !json.startsWith('[')) {
    return null;
  }

  let data: StylelintJsonFile[];
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) {
    return null;
  }
  // Distinguish from ESLint JSON (which uses `filePath`/`messages`).
  if (data.length > 0 && !('source' in data[0]) && !('warnings' in data[0])) {
    return null;
  }

  const issues: ParsedIssue[] = [];
  for (const fileResult of data) {
    if (!fileResult || typeof fileResult.source !== 'string') {
      continue;
    }
    const file = resolveFilePath(cwd, fileResult.source);
    for (const w of fileResult.warnings ?? []) {
      const line = Math.max(0, (w.line ?? 1) - 1);
      const column = Math.max(0, (w.column ?? 1) - 1);
      const endColumn = w.endColumn ? Math.max(column + 1, w.endColumn - 1) : undefined;
      issues.push({
        file,
        line,
        column,
        endColumn,
        message: appendRule((w.text ?? '').trim(), w.rule),
        severity: w.severity === 'error' ? 'error' : 'warning',
      });
    }
  }
  return issues;
}

/** Parse stylelint text output (compact or stylish). */
export function parseStylelintText(rawOutput: string, cwd: string): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  const lines = rawOutput.split(/\r?\n/);
  let currentFile: string | null = null;

  for (const line of lines) {
    const compactMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+)$/);
    if (compactMatch) {
      const [, filePart, lineStr, colStr, sev, message] = compactMatch;
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      issues.push({
        file: resolveFilePath(cwd, filePart!),
        line: lineNum,
        column: colNum,
        endColumn: Math.max(colNum + 1, 80),
        message: message!.trim(),
        severity: sev === 'error' ? 'error' : 'warning',
      });
      continue;
    }

    const stylishMatch = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)$/);
    if (stylishMatch && currentFile) {
      const [, lineStr, colStr, sev, message] = stylishMatch;
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      issues.push({
        file: resolveFilePath(cwd, currentFile),
        line: lineNum,
        column: colNum,
        endColumn: Math.max(colNum + 1, 80),
        message: message.trim(),
        severity: sev === 'error' ? 'error' : 'warning',
      });
      continue;
    }

    if (line.trim().length > 0 && !/^\s/.test(line)) {
      const filePart = line.trim();
      if (/\.(css|scss|sass|less|html)$/i.test(filePart)) {
        currentFile = filePart;
      } else {
        currentFile = null;
      }
    }
  }
  return issues;
}

/** Parse stylelint output, preferring JSON and falling back to text. */
export function parseStylelintOutput(rawOutput: string, cwd: string): ParsedIssue[] {
  const json = parseStylelintJson(rawOutput, cwd);
  if (json !== null) {
    return json;
  }
  return parseStylelintText(rawOutput, cwd);
}
