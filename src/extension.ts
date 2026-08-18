import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import {
  ParsedIssue,
  IssueSeverity,
  parseDepcheckOutput,
  parseTsPruneOutput,
  parseEslintOutput,
  parseStylelintOutput,
} from './diagnostics';

const DIAGNOSTIC_SOURCE = 'Angular Code Quality';

/** One diagnostic collection per tool so results accumulate instead of overwriting each other. */
type ToolKey = 'depcheck' | 'ts-prune' | 'eslint' | 'stylelint';

const collections = new Map<ToolKey, vscode.DiagnosticCollection>();
let outputChannel: vscode.OutputChannel | undefined;

interface ToolkitConfig {
  tsconfigPath: string;
  stylelintGlobs: string[];
  eslintUseJson: boolean;
  stylelintUseJson: boolean;
  revealOutput: boolean;
}

function getConfig(): ToolkitConfig {
  const c = vscode.workspace.getConfiguration('angularCodeQuality');
  return {
    tsconfigPath: c.get<string>('tsPrune.tsconfigPath', 'tsconfig.app.json'),
    stylelintGlobs: c.get<string[]>('stylelint.globs', ['src/**/*.scss', 'src/**/*.css']),
    eslintUseJson: c.get<boolean>('eslint.useJsonFormat', true),
    stylelintUseJson: c.get<boolean>('stylelint.useJsonFormat', true),
    revealOutput: c.get<boolean>('revealOutputOnRun', true),
  };
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(
      'Angular Code Quality Toolkit: No workspace folder is open. Open your Angular project folder and try again.'
    );
    return undefined;
  }
  return folders[0];
}

function getOutputChannel(reveal: boolean): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Angular Code Quality');
  }
  if (reveal) {
    outputChannel.show(true);
  }
  return outputChannel;
}

/** Quote a value coming from user settings so paths/globs with spaces survive the shell. */
function shellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const buffer = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(buffer).toString('utf8');
  } catch {
    return undefined;
  }
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

interface ToolResult {
  stdout: string;
  stderr: string;
  code: number | null;
  canceled: boolean;
  spawnError?: Error;
}

/** Run a shell command, streaming output. Cancellable via the progress token. */
function spawnCommand(
  command: string,
  cwd: string,
  output: vscode.OutputChannel,
  token: vscode.CancellationToken
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let canceled = false;

    // On Unix, run in a new process group so we can signal the whole tree (the
    // shell plus its npx/node grandchildren) on cancel. `detached` has different
    // semantics on Windows, where we use taskkill instead.
    const isWindows = process.platform === 'win32';
    const child = spawn(command, { cwd, shell: true, detached: !isWindows });

    const cancelSub = token.onCancellationRequested(() => {
      canceled = true;
      if (!child.pid) {
        return;
      }
      // With shell:true the direct child is the shell (cmd.exe / sh); the real
      // CLI runs as a grandchild, so killing only the child leaks the CLI.
      if (isWindows) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      }
    });

    child.stdout?.on('data', (data: Buffer) => {
      const s = data.toString();
      stdout += s;
      output.append(s);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const s = data.toString();
      stderr += s;
      output.append(s);
    });
    child.on('error', (err: Error) => {
      cancelSub.dispose();
      resolve({ stdout, stderr, code: null, canceled, spawnError: err });
    });
    child.on('close', (code: number | null) => {
      cancelSub.dispose();
      resolve({ stdout, stderr, code, canceled });
    });
  });
}

/** Heuristic: did the underlying CLI fail to launch (not installed / not on PATH)? */
function isToolMissing(result: ToolResult): boolean {
  if (result.spawnError) {
    return true;
  }
  if (result.code === 127) {
    return true;
  }
  const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    combined.includes('is not recognized as an internal') ||
    combined.includes('command not found') ||
    combined.includes('could not determine executable to run') ||
    combined.includes('npm error could not determine')
  );
}

function toDiagnostic(issue: ParsedIssue): { uri: vscode.Uri; diagnostic: vscode.Diagnostic } {
  const severityMap: Record<IssueSeverity, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  };
  const endColumn = issue.endColumn ?? issue.column + 1;
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(issue.line, issue.column, issue.line, Math.max(endColumn, issue.column + 1)),
    issue.message,
    severityMap[issue.severity]
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  return { uri: vscode.Uri.file(issue.file), diagnostic };
}

function applyDiagnostics(collection: vscode.DiagnosticCollection, issues: ParsedIssue[]): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const issue of issues) {
    const { uri, diagnostic } = toDiagnostic(issue);
    const key = uri.toString();
    const list = byUri.get(key) ?? [];
    list.push(diagnostic);
    byUri.set(key, list);
  }
  for (const [uriStr, diagnostics] of byUri) {
    collection.set(vscode.Uri.parse(uriStr), diagnostics);
  }
}

function reportSummary(
  label: string,
  noun: string,
  count: number,
  output: vscode.OutputChannel,
  quiet: boolean
): void {
  const plural = count === 1 ? '' : 's';
  if (count > 0) {
    output.appendLine(`\n[Angular Code Quality] ${label}: ${count} ${noun}${plural}. See the Problems view.`);
    if (!quiet) {
      vscode.window.showInformationMessage(
        `Angular Code Quality — ${label}: ${count} ${noun}${plural}. Check the Problems view and editor.`
      );
    }
  } else {
    output.appendLine(`\n[Angular Code Quality] ${label}: no ${noun}s found. ✓`);
    if (!quiet) {
      vscode.window.setStatusBarMessage(`Angular Code Quality — ${label}: clean ✓`, 4000);
    }
  }
}

interface RunOptions {
  label: string;
  command: string;
  cwd: string;
  toolKey: ToolKey;
  noun: string;
  parse: (raw: string, result: ToolResult) => ParsedIssue[];
  /** Optional install hint shown when the underlying tool is missing. */
  installHint?: string;
  /** Optional inspection of raw output for extra, tool-specific notifications. */
  onRaw?: (raw: string, result: ToolResult) => void;
  /**
   * When set, the tool run does not show its own progress toast or success
   * notification (used by "Run all checks", which owns one shared progress and a
   * single final summary). The provided token drives cancellation.
   */
  quiet?: boolean;
  token?: vscode.CancellationToken;
}

/** Shared execution + reporting pipeline for a single tool run. Returns issue count (-1 if aborted). */
async function runTool(options: RunOptions): Promise<number> {
  const { revealOutput } = getConfig();
  const output = getOutputChannel(revealOutput);
  output.appendLine(`\n> ${options.command}`);
  output.appendLine(`Running in ${options.cwd} ...`);

  const result =
    options.quiet && options.token
      ? await spawnCommand(options.command, options.cwd, output, options.token)
      : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Angular Code Quality: ${options.label}…`,
            cancellable: true,
          },
          (_progress, token) => spawnCommand(options.command, options.cwd, output, token)
        );

  if (result.canceled) {
    output.appendLine('\n[Angular Code Quality] Canceled.');
    return -1;
  }

  if (isToolMissing(result)) {
    const hint = options.installHint
      ? ` ${options.installHint}`
      : ' Make sure the required tool is installed and available on your PATH.';
    output.appendLine(`\n[Angular Code Quality] ${options.label} could not run.${hint}`);
    vscode.window.showErrorMessage(`Angular Code Quality — ${options.label} could not run.${hint}`);
    return -1;
  }

  const raw = result.stdout.trim() || result.stderr.trim();
  options.onRaw?.(raw, result);

  const issues = options.parse(raw, result);
  const collection = collections.get(options.toolKey)!;
  applyDiagnostics(collection, issues);

  // A non-zero exit with nothing parseable almost always means the command
  // itself errored (e.g. `ng lint` rejecting `--format json`, a bad config, or a
  // crash) rather than a clean project. Never report that as "clean ✓".
  if (issues.length === 0 && result.code !== 0 && result.code !== null) {
    const message =
      `Angular Code Quality — ${options.label} exited with code ${result.code} but produced no recognizable results. ` +
      'It likely failed — see the output channel.';
    output.appendLine(`\n[Angular Code Quality] ${message}`);
    vscode.window.showWarningMessage(message);
    return -1;
  }

  reportSummary(options.label, options.noun, issues.length, output, options.quiet ?? false);
  return issues.length;
}

interface BatchOptions {
  quiet?: boolean;
  token?: vscode.CancellationToken;
}

async function runDepcheck(batch: BatchOptions = {}): Promise<number> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return -1;
  }
  const cwd = folder.uri.fsPath;
  const packageJsonPath = path.join(cwd, 'package.json');
  const packageJsonContent = await readFileText(vscode.Uri.file(packageJsonPath));

  return runTool({
    label: 'depcheck',
    command: 'npx --yes depcheck --json',
    cwd,
    toolKey: 'depcheck',
    noun: 'dependency issue',
    installHint: 'Install it with: npm install --save-dev depcheck',
    parse: (raw) => parseDepcheckOutput(raw, cwd, packageJsonPath, packageJsonContent),
    ...batch,
  });
}

async function runTsPrune(batch: BatchOptions = {}): Promise<number> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return -1;
  }
  const cwd = folder.uri.fsPath;
  const { tsconfigPath } = getConfig();
  const tsconfigUri = vscode.Uri.file(path.join(cwd, tsconfigPath));
  const exists = await pathExists(tsconfigUri);

  if (!exists) {
    const message =
      `Angular Code Quality: "${tsconfigPath}" was not found in the workspace root. ` +
      'Running ts-prune without a project file (results may be less precise). ' +
      'You can set "angularCodeQuality.tsPrune.tsconfigPath" in Settings.';
    getOutputChannel(getConfig().revealOutput).appendLine(`\n${message}`);
    vscode.window.showWarningMessage(message);
  }

  const command = exists
    ? `npx --yes ts-prune -p ${shellArg(tsconfigPath)}`
    : 'npx --yes ts-prune';

  return runTool({
    label: 'ts-prune',
    command,
    cwd,
    toolKey: 'ts-prune',
    noun: 'unused export',
    installHint: 'Install it with: npm install --save-dev ts-prune',
    parse: (raw) => parseTsPruneOutput(raw, cwd),
    ...batch,
  });
}

async function runEslint(batch: BatchOptions = {}): Promise<number> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return -1;
  }
  const cwd = folder.uri.fsPath;
  const { eslintUseJson, revealOutput } = getConfig();
  const output = getOutputChannel(revealOutput);

  const contents = await readFileText(vscode.Uri.file(path.join(cwd, 'package.json')));
  if (!contents) {
    const message =
      'Angular Code Quality: package.json was not found in the workspace root. ESLint is typically run via an npm "lint" script.';
    output.appendLine(`\n${message}`);
    vscode.window.showErrorMessage(message);
    return -1;
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(contents);
  } catch {
    const message = 'Angular Code Quality: Could not parse package.json. Check that it is valid JSON.';
    output.appendLine(`\n${message}`);
    vscode.window.showErrorMessage(message);
    return -1;
  }

  if (!pkg.scripts || !pkg.scripts.lint) {
    const message =
      'Angular Code Quality: No "lint" script found in package.json. Add one (e.g. "lint": "ng lint"), or run "Add ESLint to Angular project".';
    output.appendLine(`\n${message}`);
    const choice = await vscode.window.showWarningMessage(message, 'Add ESLint to Angular project');
    if (choice) {
      addEslintToAngular();
    }
    return -1;
  }

  const command = eslintUseJson ? 'npm run lint -- --format json' : 'npm run lint';

  return runTool({
    label: 'ESLint',
    command,
    cwd,
    toolKey: 'eslint',
    noun: 'lint issue',
    installHint: 'Ensure ESLint is installed and your "lint" script works (try running it in a terminal).',
    parse: (raw) => parseEslintOutput(raw, cwd),
    ...batch,
    onRaw: (raw) => {
      if (raw.includes('tslint') || raw.includes('Cannot find builder')) {
        vscode.window
          .showErrorMessage(
            'Angular Code Quality: This project still uses TSLint (removed in Angular 12+). Migrate to ESLint?',
            'Add ESLint to Angular project'
          )
          .then((choice) => {
            if (choice) {
              addEslintToAngular();
            }
          });
      }
    },
  });
}

async function runStylelint(batch: BatchOptions = {}): Promise<number> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return -1;
  }
  const cwd = folder.uri.fsPath;
  const { stylelintGlobs, stylelintUseJson } = getConfig();

  const contents = await readFileText(vscode.Uri.file(path.join(cwd, 'package.json')));
  let scriptCommand: string | undefined;
  if (contents) {
    try {
      const pkg = JSON.parse(contents) as { scripts?: Record<string, string> };
      if (pkg.scripts?.['lint:styles']) {
        scriptCommand = 'npm run lint:styles';
      } else if (pkg.scripts?.stylelint) {
        scriptCommand = 'npm run stylelint';
      }
    } catch {
      // Ignore parse errors; fall back to npx.
    }
  }

  let command: string;
  if (scriptCommand) {
    command = stylelintUseJson ? `${scriptCommand} -- --formatter json` : scriptCommand;
  } else {
    const globs = stylelintGlobs.map(shellArg).join(' ');
    command = stylelintUseJson
      ? `npx --yes stylelint ${globs} --allow-empty-input --formatter json`
      : `npx --yes stylelint ${globs} --allow-empty-input`;
  }

  return runTool({
    label: 'stylelint',
    command,
    cwd,
    toolKey: 'stylelint',
    noun: 'style issue',
    installHint: 'Install it with: npm install --save-dev stylelint stylelint-config-standard-scss',
    parse: (raw) => parseStylelintOutput(raw, cwd),
    ...batch,
  });
}

function addEslintToAngular(): void {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return;
  }
  // `ng add` is interactive (it prompts). Run it in a real terminal so the user can answer.
  const terminal = vscode.window.createTerminal({
    name: 'Angular Code Quality: Add ESLint',
    cwd: folder.uri.fsPath,
  });
  terminal.show();
  terminal.sendText('npx ng add @angular-eslint/schematics');
  vscode.window.showInformationMessage(
    'Angular Code Quality: Running "ng add @angular-eslint/schematics" in the terminal. Answer the prompts, then run "Run ESLint".'
  );
}

async function runAllChecks(): Promise<void> {
  if (!getWorkspaceFolder()) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Angular Code Quality: running all checks…',
      cancellable: true,
    },
    async (progress, token) => {
      const results: string[] = [];
      const steps: { label: string; run: (b: BatchOptions) => Promise<number> }[] = [
        { label: 'depcheck', run: runDepcheck },
        { label: 'ts-prune', run: runTsPrune },
        { label: 'ESLint', run: runEslint },
        { label: 'stylelint', run: runStylelint },
      ];

      for (const step of steps) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({ message: step.label });
        const count = await step.run({ quiet: true, token });
        if (count >= 0) {
          results.push(`${step.label}: ${count}`);
        }
      }

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('Angular Code Quality — checks canceled.');
        return;
      }
      vscode.window.showInformationMessage(
        `Angular Code Quality — all checks done (${results.join(', ') || 'no results'}).`
      );
    }
  );
}

function clearAllDiagnostics(): void {
  for (const collection of collections.values()) {
    collection.clear();
  }
  vscode.window.setStatusBarMessage('Angular Code Quality: cleared all results.', 3000);
}

export function activate(context: vscode.ExtensionContext): void {
  const toolKeys: ToolKey[] = ['depcheck', 'ts-prune', 'eslint', 'stylelint'];
  for (const key of toolKeys) {
    const collection = vscode.languages.createDiagnosticCollection(`${DIAGNOSTIC_SOURCE}: ${key}`);
    collections.set(key, collection);
    context.subscriptions.push(collection);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('angularCodeQualityToolkit.runDepcheck', () => runDepcheck()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runTsPrune', () => runTsPrune()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runEslint', () => runEslint()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runStylelint', () => runStylelint()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.addEslintToAngular', () =>
      addEslintToAngular()
    ),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runAllChecks', () => runAllChecks()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.clearDiagnostics', () =>
      clearAllDiagnostics()
    )
  );
}

export function deactivate(): void {
  outputChannel?.dispose();
  for (const collection of collections.values()) {
    collection.dispose();
  }
  collections.clear();
}
