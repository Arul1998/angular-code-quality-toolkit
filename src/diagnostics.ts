import * as vscode from 'vscode';
import * as path from 'path';

export interface DiagnosticEntry {
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

/** Parse depcheck --json output and return diagnostics (package.json for unused/missing deps). */
export function parseDepcheckOutput(
  rawOutput: string,
  cwd: string,
  packageJsonPath: string,
  packageJsonContent?: string
): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  const packageJsonUri = vscode.Uri.file(packageJsonPath);

  try {
    const data = JSON.parse(rawOutput) as {
      dependencies?: string[];
      devDependencies?: string[];
      missing?: Record<string, string[]>;
    };

    const unused = [...(data.dependencies ?? []), ...(data.devDependencies ?? [])];
    for (const dep of unused) {
      const line = packageJsonContent ? getPackageJsonLineForDependency(packageJsonContent, dep) : 0;
      entries.push({
        uri: packageJsonUri,
        diagnostic: new vscode.Diagnostic(
          new vscode.Range(line, 0, line, 200),
          `Unused dependency: ${dep}`,
          vscode.DiagnosticSeverity.Information
        ),
      });
    }

    const missing = data.missing ?? {};
    for (const [dep, files] of Object.entries(missing)) {
      const firstFile = Array.isArray(files) ? files[0] : (files as unknown as string);
      if (firstFile && typeof firstFile === 'string') {
        const uri = toFileUri(cwd, firstFile);
        entries.push({
          uri,
          diagnostic: new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, 0),
            `Missing dependency: ${dep}`,
            vscode.DiagnosticSeverity.Warning
          ),
        });
      }
    }
  } catch {
    // Not JSON or invalid - ignore
  }
  return entries;
}

/** Find line number in package.json where dependency name appears (e.g. "lodash"). */
export function getPackageJsonLineForDependency(
  content: string,
  depName: string
): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`"${depName}"`)) {
      return i;
    }
  }
  return 0;
}

/**
 * Resolve a path from ts-prune/eslint to a full absolute path using project root (cwd)
 * so "Open" in Problems always works (e.g. C:\Users\...\OrderManager\src\app\...).
 * Paths like \src\app\... (no drive) are treated as relative to cwd so we get the real file.
 */
function toFileUri(projectRoot: string, filePart: string): vscode.Uri {
  const trimmed = filePart.trim().replace(/\//g, path.sep);
  const relativeToRoot = trimmed.replace(/^[/\\]+/, ''); // strip leading slashes so we always resolve from project root
  const absolute = path.resolve(projectRoot, relativeToRoot);
  return vscode.Uri.file(absolute);
}

/** Parse ts-prune output. Supports "file:line - symbol" and "file  symbol" (fallback). */
export function parseTsPruneOutput(
  rawOutput: string,
  cwd: string,
  _workspaceUri?: vscode.Uri
): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  const lines = rawOutput.split(/\r?\n/).filter((l) => l.trim());

  for (const line of lines) {
    const matchWithLine = line.match(/^(.+?):(\d+)\s*-\s*(.+)$/);
    if (matchWithLine) {
      const [, filePart, lineStr, symbol] = matchWithLine;
      const uri = toFileUri(cwd, filePart!);
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      entries.push({
        uri,
        diagnostic: new vscode.Diagnostic(
          new vscode.Range(lineNum, 0, lineNum, 100),
          `Unused export: ${symbol!.trim()}`,
          vscode.DiagnosticSeverity.Information
        ),
      });
      continue;
    }
    const matchNoLine = line.match(/^(.+?)\s{2,}(.+)$/);
    if (matchNoLine) {
      const [, filePart, symbol] = matchNoLine;
      const uri = toFileUri(cwd, filePart!);
      entries.push({
        uri,
        diagnostic: new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 100),
          `Unused export: ${symbol!.trim()}`,
          vscode.DiagnosticSeverity.Information
        ),
      });
    }
  }
  return entries;
}

/** Parse ESLint output. Handles "file:line:col: message", and stylish (file on one line, "  line  col  severity  message" on next). */
export function parseEslintOutput(
  rawOutput: string,
  cwd: string,
  _workspaceUri?: vscode.Uri
): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  const lines = rawOutput.split(/\r?\n/);
  let currentFile: string | null = null;

  const toUri = (filePart: string): vscode.Uri => toFileUri(cwd, filePart);

  for (const line of lines) {
    const unixMatch = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
    if (unixMatch) {
      const [, filePart, lineStr, colStr, message] = unixMatch;
      const uri = toUri(filePart!);
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      const severity = (message?.toLowerCase().includes('error') ?? false)
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
      entries.push({
        uri,
        diagnostic: new vscode.Diagnostic(
          new vscode.Range(lineNum, colNum, lineNum, Math.max(colNum + 1, 80)),
          message!.trim(),
          severity
        ),
      });
      continue;
    }
    const stylishMatch = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)$/);
    if (stylishMatch && currentFile) {
      const [, lineStr, colStr, sev, message] = stylishMatch;
      const uri = toUri(currentFile);
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      const severity =
        sev === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      entries.push({
        uri,
        diagnostic: new vscode.Diagnostic(
          new vscode.Range(lineNum, colNum, lineNum, Math.max(colNum + 1, 80)),
          message.trim(),
          severity
        ),
      });
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      const filePart = line.trim();
      if (!filePart.includes(' ') || filePart.endsWith('.ts') || filePart.endsWith('.js') || filePart.endsWith('.html')) {
        currentFile = filePart;
      } else {
        currentFile = null;
      }
    }
  }
  return entries;
}

/** Parse stylelint output. Handles "file:line:col severity message" (compact) and file-per-line + next line. */
export function parseStylelintOutput(rawOutput: string, cwd: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  const lines = rawOutput.split(/\r?\n/);
  let currentFile: string | null = null;

  const toUri = (filePart: string): vscode.Uri => toFileUri(cwd, filePart);

  for (const line of lines) {
    const compactMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+)$/);
    if (compactMatch) {
      const [, filePart, lineStr, colStr, sev, message] = compactMatch;
      const uri = toUri(filePart!);
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      const severity =
        sev === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      entries.push({
        uri,
        diagnostic: new vscode.Diagnostic(
          new vscode.Range(lineNum, colNum, lineNum, Math.max(colNum + 1, 80)),
          message!.trim(),
          severity
        ),
      });
      continue;
    }
    const stylishMatch = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)$/);
    if (stylishMatch && currentFile) {
      const [, lineStr, colStr, sev, message] = stylishMatch;
      const uri = toUri(currentFile);
      const lineNum = Math.max(0, parseInt(lineStr!, 10) - 1);
      const colNum = Math.max(0, parseInt(colStr!, 10) - 1);
      const severity =
        sev === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      entries.push({
        uri,
        diagnostic: new vscode.Diagnostic(
          new vscode.Range(lineNum, colNum, lineNum, Math.max(colNum + 1, 80)),
          message.trim(),
          severity
        ),
      });
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      const filePart = line.trim();
      if (
        filePart.endsWith('.css') ||
        filePart.endsWith('.scss') ||
        filePart.endsWith('.less') ||
        filePart.endsWith('.html')
      ) {
        currentFile = filePart;
      } else {
        currentFile = null;
      }
    }
  }
  return entries;
}

/** Convert entries to a map by URI and optionally fix package.json ranges using file content. */
export function entriesToMap(entries: DiagnosticEntry[]): Map<string, vscode.Diagnostic[]> {
  const map = new Map<string, vscode.Diagnostic[]>();
  for (const { uri, diagnostic } of entries) {
    const key = uri.toString();
    const list = map.get(key) ?? [];
    list.push(diagnostic);
    map.set(key, list);
  }
  return map;
}
