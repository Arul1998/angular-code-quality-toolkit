import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import {
  ParsedIssue,
  ToolKey,
  buildDiagnosticShape,
  parseDepcheckOutput,
  parseTsPruneOutput,
  parseEslintOutput,
  parseStylelintOutput,
  ANGULAR_IMPLICIT_PATTERNS,
  DIAGNOSTIC_SOURCES,
  formatProblemSummary,
} from './diagnostics';
import {
  PackageManager,
  detectPackageManager,
  binRunner,
  scriptCommand,
  addDevCommand,
} from './packageManager';
import {
  AngularProject,
  parseAngularJson,
  defaultProject,
  styleGlobsForProject,
} from './angularWorkspace';
import { toolsForSavedFile } from './runOnSave';
import {
  UNUSED_DEPENDENCY_PREFIX,
  dependencyNameFromMessage,
  removeDependencyFromPackageJson,
} from './codeActions';

const DIAGNOSTIC_SOURCE = 'Angular Code Quality';

/**
 * One diagnostic collection per tool so results accumulate instead of
 * overwriting each other, and each tool's results can be cleared/updated
 * independently. `ToolKey` and the per-tool `source` strings live in the pure
 * `diagnostics` module so they can be unit-tested without the vscode API.
 */
const collections = new Map<ToolKey, vscode.DiagnosticCollection>();
let outputChannel: vscode.OutputChannel | undefined;

/** Remembered Angular project selection per workspace folder (by fsPath -> project name). */
const activeProjectByFolder = new Map<string, string>();
let projectStatusBar: vscode.StatusBarItem | undefined;
let summaryStatusBar: vscode.StatusBarItem | undefined;

/** Tools shown in the status-bar summary, in display order, with readable labels. */
const SUMMARY_TOOLS: { key: ToolKey; label: string }[] = [
  { key: 'eslint', label: 'ESLint' },
  { key: 'stylelint', label: 'stylelint' },
  { key: 'ts-prune', label: 'ts-prune' },
  { key: 'depcheck', label: 'depcheck' },
];

/** True if the setting has an explicit user value (workspace/global), not just its default. */
function isConfigExplicitlySet(section: string): boolean {
  const info = vscode.workspace.getConfiguration('angularCodeQuality').inspect(section);
  return Boolean(
    info &&
      (info.globalValue !== undefined ||
        info.workspaceValue !== undefined ||
        info.workspaceFolderValue !== undefined)
  );
}

type PackageManagerSetting = 'auto' | PackageManager;

interface ToolkitConfig {
  tsconfigPath: string;
  stylelintGlobs: string[];
  eslintUseJson: boolean;
  stylelintUseJson: boolean;
  revealOutput: boolean;
  packageManager: PackageManagerSetting;
  depcheckIgnoreAngularImplicit: boolean;
  depcheckIgnores: string[];
}

function getConfig(): ToolkitConfig {
  const c = vscode.workspace.getConfiguration('angularCodeQuality');
  return {
    tsconfigPath: c.get<string>('tsPrune.tsconfigPath', 'tsconfig.app.json'),
    stylelintGlobs: c.get<string[]>('stylelint.globs', ['src/**/*.scss', 'src/**/*.css']),
    eslintUseJson: c.get<boolean>('eslint.useJsonFormat', true),
    stylelintUseJson: c.get<boolean>('stylelint.useJsonFormat', true),
    revealOutput: c.get<boolean>('revealOutputOnRun', false),
    packageManager: c.get<PackageManagerSetting>('packageManager', 'auto'),
    depcheckIgnoreAngularImplicit: c.get<boolean>('depcheck.ignoreAngularImplicit', true),
    depcheckIgnores: c.get<string[]>('depcheck.ignores', []),
  };
}

/** Resolve the package manager: honor the explicit setting, else detect from lockfiles. */
async function resolvePackageManager(cwd: string): Promise<PackageManager> {
  const { packageManager } = getConfig();
  if (packageManager !== 'auto') {
    return packageManager;
  }
  const has = async (name: string): Promise<boolean> =>
    pathExists(vscode.Uri.file(path.join(cwd, name)));
  return detectPackageManager({
    npm: (await has('package-lock.json')) || (await has('npm-shrinkwrap.json')),
    yarn: await has('yarn.lock'),
    pnpm: await has('pnpm-lock.yaml'),
    bun: (await has('bun.lockb')) || (await has('bun.lock')),
  });
}

async function readAngularWorkspace(cwd: string) {
  const content = await readFileText(vscode.Uri.file(path.join(cwd, 'angular.json')));
  return content ? parseAngularJson(content) : null;
}

function updateProjectStatusBar(project?: AngularProject): void {
  if (!projectStatusBar) {
    return;
  }
  if (project) {
    projectStatusBar.text = `$(symbol-namespace) NG: ${project.name}`;
    projectStatusBar.tooltip = 'Angular Code Quality: active project (click to change)';
    projectStatusBar.show();
  } else {
    projectStatusBar.hide();
  }
}

/**
 * Resolve the active Angular project for a workspace. Returns undefined when
 * there is no `angular.json`. Does not prompt unless `forcePick` is set — normal
 * runs reuse the remembered selection, or default to the primary application.
 */
async function getActiveProject(cwd: string, forcePick = false): Promise<AngularProject | undefined> {
  const workspace = await readAngularWorkspace(cwd);
  if (!workspace) {
    updateProjectStatusBar(undefined);
    return undefined;
  }

  if (forcePick) {
    const items = workspace.projects.map((p) => ({
      label: p.name,
      description: `${p.projectType ?? 'project'}${p.root ? ` · ${p.root}` : ''}`,
      project: p,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the Angular project for code-quality checks',
    });
    if (picked) {
      activeProjectByFolder.set(cwd, picked.project.name);
      updateProjectStatusBar(picked.project);
      return picked.project;
    }
    // Canceled: fall through and keep the current selection.
  }

  const remembered = activeProjectByFolder.get(cwd);
  const found = remembered ? workspace.projects.find((p) => p.name === remembered) : undefined;
  const chosen = found ?? defaultProject(workspace);
  if (chosen) {
    activeProjectByFolder.set(cwd, chosen.name);
    updateProjectStatusBar(chosen);
  }
  return chosen;
}

async function selectAngularProject(): Promise<void> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return;
  }
  const project = await getActiveProject(folder.uri.fsPath, true);
  if (!project) {
    vscode.window.showInformationMessage(
      'Angular Code Quality: No angular.json projects were found in this workspace.'
    );
  } else {
    vscode.window.setStatusBarMessage(
      `Angular Code Quality: active project → ${project.name}`,
      3000
    );
  }
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

/**
 * Turn a parsed issue into a `vscode.Diagnostic` plus the file URI it belongs
 * to. The range/severity/source are computed by the pure `buildDiagnosticShape`
 * so the mapping is unit-tested; here we only adapt it to vscode types. The
 * `severityRank` values match `vscode.DiagnosticSeverity` exactly.
 */
function toDiagnostic(
  issue: ParsedIssue,
  toolKey: ToolKey
): { uri: vscode.Uri; diagnostic: vscode.Diagnostic } {
  const shape = buildDiagnosticShape(issue, toolKey);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(shape.startLine, shape.startColumn, shape.endLine, shape.endColumn),
    shape.message,
    shape.severityRank as vscode.DiagnosticSeverity
  );
  diagnostic.source = shape.source;
  return { uri: vscode.Uri.file(shape.file), diagnostic };
}

/**
 * Replace a tool's diagnostics wholesale. `collection.set(entries)` clears any
 * previous contents and applies the new ones atomically, so stale results for
 * that tool cannot linger and duplicates cannot accumulate across runs.
 */
function applyDiagnostics(
  collection: vscode.DiagnosticCollection,
  toolKey: ToolKey,
  issues: ParsedIssue[]
): void {
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const issue of issues) {
    let uri: vscode.Uri;
    let diagnostic: vscode.Diagnostic;
    try {
      ({ uri, diagnostic } = toDiagnostic(issue, toolKey));
    } catch {
      // A single unrepresentable issue (e.g. an unusable file path) must not
      // sink the whole batch.
      continue;
    }
    const key = uri.toString();
    const list = byUri.get(key) ?? [];
    list.push(diagnostic);
    byUri.set(key, list);
  }
  const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
  for (const [uriStr, diagnostics] of byUri) {
    entries.push([vscode.Uri.parse(uriStr), diagnostics]);
  }
  collection.set(entries);
  updateSummaryStatusBar();
}

/**
 * Refresh the status-bar summary from the current diagnostics across every tool.
 * Shows a grand total (error icon when any error-severity problem exists, warning
 * icon otherwise, check when clean) with a per-tool breakdown in the tooltip.
 * Called after each run; hidden by "Clear results".
 */
function updateSummaryStatusBar(): void {
  if (!summaryStatusBar) {
    return;
  }
  let errors = 0;
  const perTool = SUMMARY_TOOLS.map(({ key, label }) => {
    let count = 0;
    collections.get(key)?.forEach((_uri, diagnostics) => {
      count += diagnostics.length;
      for (const d of diagnostics) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          errors++;
        }
      }
    });
    return { label, count };
  });

  const { total, text, tooltip } = formatProblemSummary(perTool);
  const icon = errors > 0 ? '$(error)' : total > 0 ? '$(warning)' : '$(check)';
  summaryStatusBar.text = `${icon} ${text}`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown('**Angular Code Quality — current findings**\n\n');
  md.appendMarkdown(`${tooltip}\n\nClick to open the Problems panel.`);
  summaryStatusBar.tooltip = md;
  summaryStatusBar.show();
}

/** "1 problem" / "3 problems" / "0 problems". */
function pluralizeProblems(count: number): string {
  return `${count} problem${count === 1 ? '' : 's'}`;
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
    output.appendLine(
      `\n[Angular Code Quality] ${label}: ${count} ${noun}${plural}. See the Problems view (View → Problems).`
    );
    if (!quiet) {
      // Concise completion notification; the detailed findings live in the
      // Problems panel and the editor, not in this toast.
      vscode.window.showInformationMessage(
        `Code quality scan completed: ${pluralizeProblems(count)} found (${label}).`
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
  /** Package manager used to build the command (logged for transparency). */
  packageManager?: PackageManager;
}

/** Shared execution + reporting pipeline for a single tool run. Returns issue count (-1 if aborted). */
async function runTool(options: RunOptions): Promise<number> {
  const { revealOutput } = getConfig();
  const output = getOutputChannel(revealOutput);
  output.appendLine(`\n> ${options.command}`);
  const pmNote = options.packageManager ? ` (package manager: ${options.packageManager})` : '';
  output.appendLine(`Running in ${options.cwd}${pmNote} ...`);

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
  applyDiagnostics(collection, options.toolKey, issues);

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
  const pm = await resolvePackageManager(cwd);
  const packageJsonPath = path.join(cwd, 'package.json');
  const packageJsonContent = await readFileText(vscode.Uri.file(packageJsonPath));

  // Build the "known-implicit, don't report as unused" list: curated Angular
  // packages + builders discovered in angular.json + user-configured patterns.
  const { depcheckIgnoreAngularImplicit, depcheckIgnores } = getConfig();
  const workspace = await readAngularWorkspace(cwd);
  const ignorePatterns = [
    ...(depcheckIgnoreAngularImplicit ? ANGULAR_IMPLICIT_PATTERNS : []),
    ...(workspace?.builders ?? []),
    ...depcheckIgnores,
  ];

  return runTool({
    label: 'depcheck',
    command: `${binRunner(pm)} depcheck --json`,
    cwd,
    toolKey: 'depcheck',
    noun: 'dependency issue',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'depcheck')}`,
    parse: (raw) => parseDepcheckOutput(raw, cwd, packageJsonPath, packageJsonContent, ignorePatterns),
    ...batch,
  });
}

async function runTsPrune(batch: BatchOptions = {}): Promise<number> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return -1;
  }
  const cwd = folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);
  const project = await getActiveProject(cwd);

  // Prefer an explicit user setting; otherwise use the active project's tsConfig
  // from angular.json (crucial in monorepos where it isn't at the root).
  let tsconfigPath = getConfig().tsconfigPath;
  if (!isConfigExplicitlySet('tsPrune.tsconfigPath') && project?.tsConfig) {
    tsconfigPath = project.tsConfig;
  }

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
    ? `${binRunner(pm)} ts-prune -p ${shellArg(tsconfigPath)}`
    : `${binRunner(pm)} ts-prune`;

  return runTool({
    label: 'ts-prune',
    command,
    cwd,
    toolKey: 'ts-prune',
    noun: 'unused export',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'ts-prune')}`,
    parse: (raw) => parseTsPruneOutput(raw, cwd),
    ...batch,
  });
}

async function runEslint(batch: BatchOptions = {}, fix = false): Promise<number> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return -1;
  }
  const cwd = folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);
  const { eslintUseJson, revealOutput } = getConfig();
  const output = getOutputChannel(revealOutput);
  const label = fix ? 'ESLint (--fix)' : 'ESLint';
  const fixFlag = fix ? ' --fix' : '';

  const tslintOnRaw = (raw: string): void => {
    if (raw.includes('tslint') || raw.includes('Cannot find builder')) {
      vscode.window
        .showErrorMessage(
          'Angular Code Quality: This project still uses TSLint (removed in Angular 12+). Migrate to ESLint?',
          'Add ESLint to Angular project'
        )
        .then((choice) => {
          if (choice) {
            void addEslintToAngular();
          }
        });
    }
  };

  // In a multi-project workspace, lint the *selected* project via the Angular CLI
  // so the picker actually scopes ESLint. The root "lint" script lints everything.
  const workspace = await readAngularWorkspace(cwd);
  const project = await getActiveProject(cwd);
  if (workspace && workspace.projects.length > 1 && project?.hasLintTarget) {
    const json = eslintUseJson ? ' --format json' : '';
    output.appendLine(
      `\n${fix ? 'Fixing' : 'Linting'} Angular project "${project.name}" (ng lint ${project.name}${fixFlag}).`
    );
    return runTool({
      label,
      command: `${binRunner(pm)} ng lint ${project.name}${fixFlag}${json}`,
      cwd,
      toolKey: 'eslint',
      noun: 'lint issue',
      packageManager: pm,
      installHint: 'Ensure @angular/cli and ESLint are installed in this workspace.',
      parse: (raw) => parseEslintOutput(raw, cwd),
      ...batch,
      onRaw: tslintOnRaw,
    });
  }

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
      void addEslintToAngular();
    }
    return -1;
  }

  const lintArgs = [fixFlag.trim(), eslintUseJson ? '--format json' : ''].filter(Boolean).join(' ');
  const command = scriptCommand(pm, 'lint', lintArgs || undefined);

  return runTool({
    label,
    command,
    cwd,
    toolKey: 'eslint',
    noun: 'lint issue',
    packageManager: pm,
    installHint: 'Ensure ESLint is installed and your "lint" script works (try running it in a terminal).',
    parse: (raw) => parseEslintOutput(raw, cwd),
    ...batch,
    onRaw: tslintOnRaw,
  });
}

async function runStylelint(batch: BatchOptions = {}, fix = false): Promise<number> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return -1;
  }
  const cwd = folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);
  const project = await getActiveProject(cwd);
  const { stylelintUseJson } = getConfig();
  const label = fix ? 'stylelint (--fix)' : 'stylelint';

  // Prefer an explicit user setting; otherwise scope globs to the active
  // project's source root (e.g. apps/web/src) instead of always src/.
  let stylelintGlobs = getConfig().stylelintGlobs;
  if (!isConfigExplicitlySet('stylelint.globs') && project) {
    stylelintGlobs = styleGlobsForProject(project);
  }

  const contents = await readFileText(vscode.Uri.file(path.join(cwd, 'package.json')));
  let styleScript: string | undefined;
  if (contents) {
    try {
      const pkg = JSON.parse(contents) as { scripts?: Record<string, string> };
      if (pkg.scripts?.['lint:styles']) {
        styleScript = 'lint:styles';
      } else if (pkg.scripts?.stylelint) {
        styleScript = 'stylelint';
      }
    } catch {
      // Ignore parse errors; fall back to running stylelint directly.
    }
  }

  let command: string;
  if (styleScript) {
    const styleArgs = [fix ? '--fix' : '', stylelintUseJson ? '--formatter json' : '']
      .filter(Boolean)
      .join(' ');
    command = scriptCommand(pm, styleScript, styleArgs || undefined);
    if (project && !isConfigExplicitlySet('stylelint.globs')) {
      getOutputChannel(getConfig().revealOutput).appendLine(
        `\n[Angular Code Quality] Using your "${styleScript}" script — its file patterns win over the ` +
          `selected project (${project.name}). Remove that script to scope stylelint to the project.`
      );
    }
  } else {
    const globs = stylelintGlobs.map(shellArg).join(' ');
    const fixArg = fix ? ' --fix' : '';
    const jsonArg = stylelintUseJson ? ' --formatter json' : '';
    command = `${binRunner(pm)} stylelint ${globs}${fixArg} --allow-empty-input${jsonArg}`;
  }

  return runTool({
    label,
    command,
    cwd,
    toolKey: 'stylelint',
    noun: 'style issue',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'stylelint stylelint-config-standard-scss')}`,
    parse: (raw) => parseStylelintOutput(raw, cwd),
    ...batch,
  });
}

/**
 * Run ESLint / stylelint with `--fix` to auto-repair fixable problems, then let
 * the normal parse step refresh the Problems panel with whatever remains. Open
 * files are saved first so the tools don't overwrite unsaved editor changes on
 * disk; VS Code reloads the (now clean) files after they're fixed.
 */
async function fixEslint(): Promise<void> {
  await vscode.workspace.saveAll(false);
  await runEslint({}, true);
}

async function fixStylelint(): Promise<void> {
  await vscode.workspace.saveAll(false);
  await runStylelint({}, true);
}

async function addEslintToAngular(): Promise<void> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return;
  }
  const pm = await resolvePackageManager(folder.uri.fsPath);
  const command = `${binRunner(pm)} ng add @angular-eslint/schematics`;
  // `ng add` is interactive (it prompts). Run it in a real terminal so the user can answer.
  const terminal = vscode.window.createTerminal({
    name: 'Angular Code Quality: Add ESLint',
    cwd: folder.uri.fsPath,
  });
  terminal.show();
  terminal.sendText(command);
  vscode.window.showInformationMessage(
    'Angular Code Quality: Running "ng add @angular-eslint/schematics" in the terminal. Answer the prompts, then run "Run ESLint".'
  );
}

async function runAllChecks(): Promise<void> {
  if (!getWorkspaceFolder()) {
    return;
  }

  const output = getOutputChannel(getConfig().revealOutput);

  // Start from a clean slate so results from a previous run — including tools
  // that fail to launch this time and therefore never re-populate their own
  // collection — cannot linger in the Problems panel.
  clearDiagnosticCollections();
  output.appendLine('\n[Angular Code Quality] Running all checks (cleared previous results)…');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Angular Code Quality: running all checks…',
      cancellable: true,
    },
    async (progress, token) => {
      const steps: { label: string; run: (b: BatchOptions) => Promise<number> }[] = [
        { label: 'ESLint', run: runEslint },
        { label: 'Stylelint', run: runStylelint },
        { label: 'ts-prune', run: runTsPrune },
        { label: 'depcheck', run: runDepcheck },
      ];

      const counts = new Map<string, number>();
      for (const step of steps) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({ message: step.label });
        const count = await step.run({ quiet: true, token });
        counts.set(step.label, count);
      }

      if (token.isCancellationRequested) {
        output.appendLine(
          '\n[Angular Code Quality] Canceled — the Problems panel shows only partial results from this run.'
        );
        vscode.window.showWarningMessage('Angular Code Quality — checks canceled (partial results).');
        return;
      }

      // Build a per-tool breakdown plus a grand total. A tool that failed to run
      // reports -1; surface that as "not run" rather than folding it into 0.
      let total = 0;
      const outputLines: string[] = [];
      const toastParts: string[] = [];
      for (const step of steps) {
        const count = counts.get(step.label);
        if (count === undefined) {
          continue;
        }
        if (count < 0) {
          outputLines.push(`${step.label}: not run (see output)`);
          toastParts.push(`${step.label} not run`);
        } else {
          total += count;
          outputLines.push(`${step.label}: ${pluralizeProblems(count)}`);
          toastParts.push(`${step.label} ${count}`);
        }
      }

      // Full breakdown → output channel (multi-line survives there).
      output.appendLine('\n[Angular Code Quality] Scan completed.');
      for (const line of outputLines) {
        output.appendLine(`  ${line}`);
      }
      output.appendLine(`  Total: ${pluralizeProblems(total)}`);
      output.appendLine('See the Problems view (View → Problems) for details.');

      // Concise single-line toast (VS Code collapses newlines in notifications).
      vscode.window.showInformationMessage(
        `Angular Code Quality — scan completed: ${pluralizeProblems(total)} (${toastParts.join(', ')}).`
      );
    }
  );
}

/** Clear every collection this extension owns, without any user-facing message. */
function clearDiagnosticCollections(): void {
  for (const collection of collections.values()) {
    collection.clear();
  }
}

/**
 * Clear only the diagnostics this extension created. Because each collection is
 * owned by this extension, `.clear()` never touches diagnostics contributed by
 * TypeScript, the Angular Language Service, the ESLint extension, or anything else.
 */
function clearAllDiagnostics(): void {
  clearDiagnosticCollections();
  summaryStatusBar?.hide();
  vscode.window.setStatusBarMessage('Angular Code Quality: cleared all results.', 3000);
}

// --- Run on save ------------------------------------------------------------

/** Coalesce rapid saves (e.g. Save All, formatters re-saving) into one run. */
const RUN_ON_SAVE_DEBOUNCE_MS = 800;
let runOnSaveTimer: ReturnType<typeof setTimeout> | undefined;
const pendingRunOnSaveTools = new Set<ToolKey>();

/** Invoke a single tool's run quietly (no toast/progress) for background refreshes. */
async function runToolByKey(tool: ToolKey): Promise<void> {
  const quiet = { quiet: true };
  switch (tool) {
    case 'depcheck':
      await runDepcheck(quiet);
      break;
    case 'ts-prune':
      await runTsPrune(quiet);
      break;
    case 'eslint':
      await runEslint(quiet);
      break;
    case 'stylelint':
      await runStylelint(quiet);
      break;
  }
}

async function flushRunOnSave(): Promise<void> {
  runOnSaveTimer = undefined;
  const tools = [...pendingRunOnSaveTools];
  pendingRunOnSaveTools.clear();
  // Run sequentially so several tools don't contend for the same package manager.
  for (const tool of tools) {
    await runToolByKey(tool);
  }
}

/** Queue the given tools and (re)start the debounce window. */
function scheduleRunOnSave(tools: ToolKey[]): void {
  for (const tool of tools) {
    pendingRunOnSaveTools.add(tool);
  }
  if (runOnSaveTimer) {
    clearTimeout(runOnSaveTimer);
  }
  runOnSaveTimer = setTimeout(() => void flushRunOnSave(), RUN_ON_SAVE_DEBOUNCE_MS);
}

function handleDidSave(document: vscode.TextDocument): void {
  if (!vscode.workspace.getConfiguration('angularCodeQuality').get<boolean>('runOnSave', false)) {
    return;
  }
  if (document.uri.scheme !== 'file') {
    return;
  }
  const folder = getWorkspaceFolder();
  if (!folder) {
    return;
  }
  // Only react to files inside the workspace folder.
  const rel = path.relative(folder.uri.fsPath, document.uri.fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return;
  }
  const tools = toolsForSavedFile(document.uri.fsPath);
  if (tools.length > 0) {
    scheduleRunOnSave(tools);
  }
}

const REMOVE_UNUSED_DEPENDENCY_COMMAND = 'angularCodeQualityToolkit.removeUnusedDependency';

/**
 * Offers a "Remove unused dependency" quick fix on each depcheck
 * "Unused dependency: <name>" diagnostic in a package.json. The heavy lifting
 * (editing the file) runs in the bound command so the pure removal logic stays
 * unit-tested in codeActions.ts.
 */
class UnusedDependencyCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCES.depcheck) {
        continue;
      }
      const depName = dependencyNameFromMessage(diagnostic.message);
      if (!depName) {
        continue;
      }
      const action = new vscode.CodeAction(
        `Remove unused dependency "${depName}"`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.command = {
        command: REMOVE_UNUSED_DEPENDENCY_COMMAND,
        title: 'Remove unused dependency',
        arguments: [document.uri, depName],
      };
      actions.push(action);
    }
    return actions;
  }
}

/**
 * Command bound to the quick fix: remove `depName` from the package.json at
 * `uri` and drop the matching depcheck diagnostic so it disappears immediately.
 */
async function removeUnusedDependency(uri: vscode.Uri, depName: string): Promise<void> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showErrorMessage(`Could not open ${uri.fsPath} to remove "${depName}".`);
    return;
  }

  const updated = removeDependencyFromPackageJson(document.getText(), depName);
  if (updated === undefined) {
    void vscode.window.showWarningMessage(
      `Couldn't remove "${depName}" automatically — edit package.json by hand (it may appear more than once).`
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  edit.replace(uri, fullRange, updated);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage(`Failed to update ${uri.fsPath}.`);
    return;
  }

  // Drop the resolved finding so it clears without waiting for the next run.
  const depcheckCollection = collections.get('depcheck');
  if (depcheckCollection) {
    const expected = `${UNUSED_DEPENDENCY_PREFIX}${depName}`;
    const remaining = (depcheckCollection.get(uri) ?? []).filter((d) => d.message !== expected);
    depcheckCollection.set(uri, remaining);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const toolKeys: ToolKey[] = ['depcheck', 'ts-prune', 'eslint', 'stylelint'];
  for (const key of toolKeys) {
    const collection = vscode.languages.createDiagnosticCollection(`${DIAGNOSTIC_SOURCE}: ${key}`);
    collections.set(key, collection);
    context.subscriptions.push(collection);
  }

  projectStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  projectStatusBar.command = 'angularCodeQualityToolkit.selectProject';
  context.subscriptions.push(projectStatusBar);

  // Problem-count summary, just right of the project item. Hidden until the first
  // run populates it; clicking opens the Problems panel.
  summaryStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  summaryStatusBar.command = 'workbench.actions.view.problems';
  context.subscriptions.push(summaryStatusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('angularCodeQualityToolkit.runDepcheck', () => runDepcheck()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runTsPrune', () => runTsPrune()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runEslint', () => runEslint()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runStylelint', () => runStylelint()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.fixEslint', () => fixEslint()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.fixStylelint', () => fixStylelint()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.addEslintToAngular', () =>
      addEslintToAngular()
    ),
    vscode.commands.registerCommand('angularCodeQualityToolkit.runAllChecks', () => runAllChecks()),
    vscode.commands.registerCommand('angularCodeQualityToolkit.clearDiagnostics', () =>
      clearAllDiagnostics()
    ),
    vscode.commands.registerCommand('angularCodeQualityToolkit.selectProject', () =>
      selectAngularProject()
    ),
    vscode.commands.registerCommand(
      REMOVE_UNUSED_DEPENDENCY_COMMAND,
      (uri: vscode.Uri, depName: string) => removeUnusedDependency(uri, depName)
    ),
    // Quick fix: "Remove unused dependency" on depcheck findings in package.json.
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/package.json' },
      new UnusedDependencyCodeActionProvider(),
      { providedCodeActionKinds: UnusedDependencyCodeActionProvider.providedCodeActionKinds }
    ),
    // Run-on-save: re-run the relevant tool(s) when a file is saved (opt-in).
    vscode.workspace.onDidSaveTextDocument(handleDidSave)
  );

  // Show the active Angular project in the status bar on startup, if any.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    void getActiveProject(folder.uri.fsPath);
  }
}

export function deactivate(): void {
  if (runOnSaveTimer) {
    clearTimeout(runOnSaveTimer);
    runOnSaveTimer = undefined;
  }
  pendingRunOnSaveTools.clear();
  outputChannel?.dispose();
  projectStatusBar?.dispose();
  projectStatusBar = undefined;
  summaryStatusBar?.dispose();
  summaryStatusBar = undefined;
  for (const collection of collections.values()) {
    collection.dispose();
  }
  collections.clear();
  activeProjectByFolder.clear();
}
