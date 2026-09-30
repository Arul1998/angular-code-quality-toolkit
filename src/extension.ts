import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ParsedIssue,
  IssueSeverity,
  ToolKey,
  buildDiagnosticShape,
  parseDepcheckOutput,
  parseTsPruneOutput,
  parseEslintOutput,
  parseStylelintOutput,
  parseKnipOutput,
  parseMadgeOutput,
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
  templateGlobsForProject,
  sourceDirForProject,
} from './angularWorkspace';
import { toolsForSavedFile } from './runOnSave';
import {
  UNUSED_DEPENDENCY_PREFIX,
  dependencyNameFromMessage,
  removeDependencyFromPackageJson,
  removeExportKeywordFromLine,
} from './codeActions';
import { ReportFinding, buildReport } from './report';
import {
  DEFAULT_STYLELINT_CONFIG,
  InstallState,
  STYLELINT_CONFIG_FILES,
  TOOLS,
  TOOL_KEYS,
  CheckSelection,
  detectInstallState,
  getTool,
  isToolKey,
  missingRecommended,
  selectChecks,
} from './tools';
import { RunRegistry } from './runRegistry';
import {
  INSTALL_TOOL_COMMAND,
  RUN_TOOL_COMMAND,
  ToolRunStatus,
  ToolViewState,
  ToolsTreeProvider,
} from './sidebar';

const DIAGNOSTIC_SOURCE = 'Angular Code Quality';

/** A run that failed / was canceled / couldn't start. */
const RUN_FAILED = -1;
/** A run that was replaced by a newer run of the same tool (its results were discarded). */
const RUN_SUPERSEDED = -2;

/**
 * One diagnostic collection per tool so results accumulate instead of
 * overwriting each other, and each tool's results can be cleared/updated
 * independently. `ToolKey` and the per-tool `source` strings live in the pure
 * `diagnostics` module so they can be unit-tested without the vscode API.
 */
const collections = new Map<ToolKey, vscode.DiagnosticCollection>();
let outputChannel: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
/** This extension's version, captured at activation for the exported report. */
let extensionVersion = '0.0.0';

/** Remembered Angular project selection per workspace folder (by fsPath -> project name). */
const activeProjectByFolder = new Map<string, string>();
let projectStatusBar: vscode.StatusBarItem | undefined;
let summaryStatusBar: vscode.StatusBarItem | undefined;

/** Guards against the same tool (or "Run all checks") running twice at once in a folder. */
const runRegistry = new RunRegistry();
/** Last run status per tool, for the sidebar. */
const runStatus = new Map<ToolKey, ToolRunStatus>();
/** Install state per tool for `currentFolder`, for the sidebar. */
const installStates = new Map<ToolKey, InstallState>();
/** The folder the sidebar and status bar describe (the last folder checks ran in). */
let currentFolder: vscode.WorkspaceFolder | undefined;
/** In a multi-root workspace, the folder the user last picked. */
let pickedFolderUri: string | undefined;
let toolsTree: ToolsTreeProvider | undefined;
let toolsView: vscode.TreeView<ToolKey> | undefined;

/** Background (quiet) runs report a missing tool / failure once per session, not on every save. */
const notifiedMissing = new Set<ToolKey>();
const notifiedFailure = new Set<ToolKey>();

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
  templateGlobs: string[];
  eslintUseJson: boolean;
  stylelintUseJson: boolean;
  revealOutput: boolean;
  packageManager: PackageManagerSetting;
  depcheckIgnoreAngularImplicit: boolean;
  depcheckIgnores: string[];
  runOnActivation: boolean;
  runOnSave: boolean;
  checks: string[];
}

function getConfig(): ToolkitConfig {
  const c = vscode.workspace.getConfiguration('angularCodeQuality');
  return {
    tsconfigPath: c.get<string>('tsPrune.tsconfigPath', 'tsconfig.app.json'),
    stylelintGlobs: c.get<string[]>('stylelint.globs', ['src/**/*.scss', 'src/**/*.css']),
    templateGlobs: c.get<string[]>('template.globs', ['src/**/*.html']),
    eslintUseJson: c.get<boolean>('eslint.useJsonFormat', true),
    stylelintUseJson: c.get<boolean>('stylelint.useJsonFormat', true),
    revealOutput: c.get<boolean>('revealOutputOnRun', false),
    packageManager: c.get<PackageManagerSetting>('packageManager', 'auto'),
    depcheckIgnoreAngularImplicit: c.get<boolean>('depcheck.ignoreAngularImplicit', true),
    depcheckIgnores: c.get<string[]>('depcheck.ignores', []),
    runOnActivation: c.get<boolean>('runOnActivation', false),
    runOnSave: c.get<boolean>('runOnSave', false),
    checks: c.get<string[]>('checks', []),
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

// --- Install detection -------------------------------------------------------

/** Is `key`'s package installed for the project at `cwd`? Checks node_modules, no spawning. */
function detectToolInstall(cwd: string, key: ToolKey): InstallState {
  return detectInstallState(cwd, getTool(key).detectPackage, (p) => fs.existsSync(p));
}

function installStateFn(cwd: string): (key: ToolKey) => InstallState {
  const cache = new Map<ToolKey, InstallState>();
  return (key) => {
    let state = cache.get(key);
    if (!state) {
      state = detectToolInstall(cwd, key);
      cache.set(key, state);
    }
    return state;
  };
}

/** What "Run all checks" (and run-on-save / export) should run in `cwd`. */
function checkSelectionFor(cwd: string): CheckSelection {
  return selectChecks(getConfig().checks, installStateFn(cwd));
}

/** Re-detect installed tools for the current folder and refresh the sidebar. */
function refreshInstallStates(): void {
  installStates.clear();
  if (currentFolder) {
    const state = installStateFn(currentFolder.uri.fsPath);
    for (const key of TOOL_KEYS) {
      installStates.set(key, state(key));
    }
  }
  toolsTree?.refresh();
}

// --- Workspace folder / project --------------------------------------------

function setCurrentFolder(folder: vscode.WorkspaceFolder): void {
  if (currentFolder?.uri.toString() === folder.uri.toString()) {
    return;
  }
  currentFolder = folder;
  refreshInstallStates();
  updateViewDescription();
  updateSummaryStatusBar();
  void getActiveProject(folder.uri.fsPath);
}

/**
 * Pick the workspace folder a command acts on:
 *  1. the only folder, in a single-folder workspace;
 *  2. the folder of the active editor's file;
 *  3. the folder the user picked last time;
 *  4. quiet (background) callers: the first folder containing angular.json;
 *     otherwise, ask.
 */
async function resolveFolder(options: { quiet?: boolean } = {}): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (!options.quiet) {
      vscode.window.showErrorMessage(
        'Angular Code Quality Toolkit: No workspace folder is open. Open your Angular project folder and try again.'
      );
    }
    return undefined;
  }

  let folder: vscode.WorkspaceFolder | undefined;
  if (folders.length === 1) {
    folder = folders[0];
  } else {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    folder =
      (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) ||
      folders.find((f) => f.uri.toString() === pickedFolderUri);
    if (!folder && options.quiet) {
      folder =
        folders.find((f) => fs.existsSync(path.join(f.uri.fsPath, 'angular.json'))) ?? folders[0];
    }
    if (!folder) {
      folder = await vscode.window.showWorkspaceFolderPick({
        placeHolder: 'Which folder should Angular Code Quality check?',
      });
      if (folder) {
        pickedFolderUri = folder.uri.toString();
      }
    }
  }

  if (folder) {
    setCurrentFolder(folder);
  }
  return folder;
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
  updateViewDescription();
}

/** Sidebar subtitle: active Angular project, plus the folder name in multi-root workspaces. */
function updateViewDescription(): void {
  if (!toolsView) {
    return;
  }
  const parts: string[] = [];
  if (currentFolder) {
    const project = activeProjectByFolder.get(currentFolder.uri.fsPath);
    if (project) {
      parts.push(project);
    }
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      parts.push(currentFolder.name);
    }
  }
  toolsView.description = parts.join(' · ') || undefined;
}

/**
 * Resolve the active Angular project for a workspace. Returns undefined when
 * there is no `angular.json`. Does not prompt unless `forcePick` is set — normal
 * runs reuse the remembered selection, or default to the primary application.
 */
async function getActiveProject(cwd: string, forcePick = false): Promise<AngularProject | undefined> {
  const workspace = await readAngularWorkspace(cwd);
  if (!workspace) {
    activeProjectByFolder.delete(cwd);
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
  const folder = await resolveFolder();
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

function isInsideFolder(cwd: string, file: string): boolean {
  const rel = path.relative(cwd, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface ToolResult {
  stdout: string;
  stderr: string;
  code: number | null;
  canceled: boolean;
  spawnError?: Error;
}

/** Run a shell command, streaming output. Cancellable via the token. */
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

    const kill = (): void => {
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
    };
    if (token.isCancellationRequested) {
      kill();
    }
    const cancelSub = token.onCancellationRequested(kill);

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

/**
 * Fallback heuristic for "the CLI failed to launch" when the node_modules
 * preflight couldn't tell (Yarn PnP, a lint script wrapping another tool, …).
 */
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
 * Replace a tool's diagnostics for one workspace folder. Every previous entry of
 * this tool under `cwd` is dropped (so a file that is now clean loses its stale
 * findings), entries for other folders are kept, and the new ones are applied.
 */
function applyDiagnostics(
  collection: vscode.DiagnosticCollection,
  toolKey: ToolKey,
  issues: ParsedIssue[],
  cwd: string
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
  const entries: [vscode.Uri, vscode.Diagnostic[] | undefined][] = [];
  // `set(entries)` only touches the listed URIs, so explicitly clear this
  // folder's previous entries that no longer have findings.
  collection.forEach((uri) => {
    if (isInsideFolder(cwd, uri.fsPath) && !byUri.has(uri.toString())) {
      entries.push([uri, undefined]);
    }
  });
  for (const [uriStr, diagnostics] of byUri) {
    entries.push([vscode.Uri.parse(uriStr), diagnostics]);
  }
  collection.set(entries);
  updateSummaryStatusBar();
}

/** Drop the given tools' diagnostics for one folder (other folders are untouched). */
function clearFolderDiagnostics(cwd: string, keys: readonly ToolKey[]): void {
  for (const key of keys) {
    const collection = collections.get(key);
    if (!collection) {
      continue;
    }
    const stale: vscode.Uri[] = [];
    collection.forEach((uri) => {
      if (isInsideFolder(cwd, uri.fsPath)) {
        stale.push(uri);
      }
    });
    for (const uri of stale) {
      collection.delete(uri);
    }
  }
  updateSummaryStatusBar();
}

/** Findings (and how many are errors) for a tool, optionally limited to one folder. */
function countDiagnostics(key: ToolKey, cwd?: string): { count: number; errors: number } {
  let count = 0;
  let errors = 0;
  collections.get(key)?.forEach((uri, diagnostics) => {
    if (cwd && !isInsideFolder(cwd, uri.fsPath)) {
      return;
    }
    count += diagnostics.length;
    for (const d of diagnostics) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
      }
    }
  });
  return { count, errors };
}

function toolViewState(key: ToolKey): ToolViewState {
  const { count, errors } = countDiagnostics(key, currentFolder?.uri.fsPath);
  return {
    status: runStatus.get(key) ?? 'idle',
    install: installStates.get(key) ?? 'unknown',
    count,
    errors,
  };
}

function setRunStatus(key: ToolKey, status: ToolRunStatus): void {
  runStatus.set(key, status);
  toolsTree?.refresh();
}

/**
 * Refresh the status-bar summary from the current diagnostics across every tool.
 * Shows a grand total (error icon when any error-severity problem exists, warning
 * icon otherwise, check when clean) with a per-tool breakdown in the tooltip for
 * every tool that has run or has findings. Hidden until something has run.
 */
function updateSummaryStatusBar(): void {
  toolsTree?.refresh();
  if (!summaryStatusBar) {
    return;
  }
  let errors = 0;
  const perTool: { label: string; count: number }[] = [];
  for (const tool of TOOLS) {
    const counts = countDiagnostics(tool.key);
    const ran = (runStatus.get(tool.key) ?? 'idle') !== 'idle';
    if (ran || counts.count > 0) {
      perTool.push({ label: tool.label, count: counts.count });
      errors += counts.errors;
    }
  }
  if (perTool.length === 0) {
    summaryStatusBar.hide();
    return;
  }

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
      void vscode.window
        .showInformationMessage(
          `Code quality scan completed: ${pluralizeProblems(count)} found (${label}).`,
          'Show problems'
        )
        .then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand('workbench.actions.view.problems');
          }
        });
    }
  } else {
    output.appendLine(`\n[Angular Code Quality] ${label}: no ${noun}s found. ✓`);
    if (!quiet) {
      vscode.window.setStatusBarMessage(`Angular Code Quality — ${label}: clean ✓`, 4000);
    }
  }
}

/** Tell the user a tool isn't installed, with a one-click Install. Background runs say it once per session. */
function notifyToolMissing(key: ToolKey, folder: vscode.WorkspaceFolder, quiet: boolean): void {
  if (quiet && notifiedMissing.has(key)) {
    return;
  }
  notifiedMissing.add(key);
  const tool = getTool(key);
  void vscode.window
    .showErrorMessage(
      `Angular Code Quality — ${tool.label} isn't installed in this project.`,
      'Install',
      'Show output'
    )
    .then((choice) => {
      if (choice === 'Install') {
        void installTools([key], folder);
      } else if (choice === 'Show output') {
        getOutputChannel(true);
      }
    });
}

/** A run exited non-zero with nothing parseable. Background runs say it once until the tool succeeds again. */
function notifyToolFailed(key: ToolKey, message: string, quiet: boolean): void {
  if (quiet && notifiedFailure.has(key)) {
    return;
  }
  notifiedFailure.add(key);
  void vscode.window
    .showWarningMessage(message, 'Show output', 'Open settings')
    .then((choice) => {
      if (choice === 'Show output') {
        getOutputChannel(true);
      } else if (choice === 'Open settings') {
        void openSettings();
      }
    });
}

/** Everything a tool runner needs: which folder, and how to present the run. */
interface RunContext {
  folder: vscode.WorkspaceFolder;
  /**
   * When set, the tool run does not show its own progress toast or success
   * notification (used by "Run all checks" / run-on-save, which own their own
   * presentation). The provided token drives cancellation.
   */
  quiet?: boolean;
  token?: vscode.CancellationToken;
}

interface RunOptions extends RunContext {
  label: string;
  command: string;
  toolKey: ToolKey;
  noun: string;
  parse: (raw: string, result: ToolResult) => ParsedIssue[];
  /** Optional install hint shown when the underlying tool is missing. */
  installHint?: string;
  /** Optional inspection of raw output for extra, tool-specific notifications. */
  onRaw?: (raw: string, result: ToolResult) => void;
  /** Package manager used to build the command (logged for transparency). */
  packageManager?: PackageManager;
}

/**
 * Shared execution + reporting pipeline for a single tool run. Returns the issue
 * count, RUN_FAILED, or RUN_SUPERSEDED (a newer run of the same tool in the same
 * folder started, so this one was canceled and its results discarded).
 */
async function runTool(options: RunOptions): Promise<number> {
  const { folder, toolKey } = options;
  const cwd = folder.uri.fsPath;
  const quiet = options.quiet ?? false;
  const output = getOutputChannel(getConfig().revealOutput);
  const previousStatus = runStatus.get(toolKey) ?? 'idle';

  // Preflight: if node_modules clearly lacks the tool, say so without spawning
  // (fast, and doesn't depend on the OS language of shell error messages).
  if (detectToolInstall(cwd, toolKey) === 'missing') {
    const hint = options.installHint ? ` ${options.installHint}` : '';
    output.appendLine(`\n[Angular Code Quality] ${options.label} is not installed in ${cwd}.${hint}`);
    if (folder === currentFolder) {
      installStates.set(toolKey, 'missing');
    }
    setRunStatus(toolKey, 'idle');
    notifyToolMissing(toolKey, folder, quiet);
    return RUN_FAILED;
  }

  output.appendLine(`\n> ${options.command}`);
  const pmNote = options.packageManager ? ` (package manager: ${options.packageManager})` : '';
  output.appendLine(`Running in ${cwd}${pmNote} ...`);

  const cts = new vscode.CancellationTokenSource();
  const externalSub = options.token?.onCancellationRequested(() => cts.cancel());
  if (options.token?.isCancellationRequested) {
    cts.cancel();
  }
  const handle = runRegistry.begin(`${cwd}|${toolKey}`, () => cts.cancel());
  setRunStatus(toolKey, 'running');

  try {
    const result = quiet
      ? await spawnCommand(options.command, cwd, output, cts.token)
      : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Angular Code Quality: ${options.label}…`,
            cancellable: true,
          },
          (_progress, token) => {
            const sub = token.onCancellationRequested(() => cts.cancel());
            return spawnCommand(options.command, cwd, output, cts.token).finally(() => sub.dispose());
          }
        );

    if (!handle.isCurrent()) {
      // A newer run of this tool owns the status and the Problems panel now.
      output.appendLine(`\n[Angular Code Quality] ${options.label}: restarted by a newer run.`);
      return RUN_SUPERSEDED;
    }

    if (result.canceled) {
      output.appendLine('\n[Angular Code Quality] Canceled.');
      setRunStatus(toolKey, previousStatus === 'running' ? 'idle' : previousStatus);
      return RUN_FAILED;
    }

    if (isToolMissing(result)) {
      const hint = options.installHint
        ? ` ${options.installHint}`
        : ' Make sure the required tool is installed and available on your PATH.';
      output.appendLine(`\n[Angular Code Quality] ${options.label} could not run.${hint}`);
      setRunStatus(toolKey, 'failed');
      notifyToolMissing(toolKey, folder, quiet);
      return RUN_FAILED;
    }

    const raw = result.stdout.trim() || result.stderr.trim();
    options.onRaw?.(raw, result);

    const issues = options.parse(raw, result);

    // A non-zero exit with nothing parseable almost always means the command
    // itself errored (e.g. `ng lint` rejecting `--format json`, a bad config, or a
    // crash) rather than a clean project. Never report that as "clean ✓", and
    // keep the previous findings rather than wiping them.
    if (issues.length === 0 && result.code !== 0 && result.code !== null) {
      const message =
        `Angular Code Quality — ${options.label} exited with code ${result.code} but produced no recognizable results. ` +
        'It likely failed — see the output channel.';
      output.appendLine(`\n[Angular Code Quality] ${message}`);
      setRunStatus(toolKey, 'failed');
      notifyToolFailed(toolKey, message, quiet);
      return RUN_FAILED;
    }

    applyDiagnostics(collections.get(toolKey)!, toolKey, issues, cwd);
    notifiedFailure.delete(toolKey);
    notifiedMissing.delete(toolKey);
    if (folder === currentFolder) {
      installStates.set(toolKey, 'installed');
    }
    setRunStatus(toolKey, 'done');
    reportSummary(options.label, options.noun, issues.length, output, quiet);
    return issues.length;
  } finally {
    handle.end();
    externalSub?.dispose();
    cts.dispose();
    updateSummaryStatusBar();
  }
}

async function runDepcheck(ctx: RunContext): Promise<number> {
  const cwd = ctx.folder.uri.fsPath;
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
    ...ctx,
    label: 'depcheck',
    command: `${binRunner(pm)} depcheck --json`,
    toolKey: 'depcheck',
    noun: 'dependency issue',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'depcheck')}`,
    parse: (raw) => parseDepcheckOutput(raw, cwd, packageJsonPath, packageJsonContent, ignorePatterns),
  });
}

async function runTsPrune(ctx: RunContext): Promise<number> {
  const cwd = ctx.folder.uri.fsPath;
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
    if (!ctx.quiet) {
      vscode.window.showWarningMessage(message);
    }
  }

  const command = exists
    ? `${binRunner(pm)} ts-prune -p ${shellArg(tsconfigPath)}`
    : `${binRunner(pm)} ts-prune`;

  return runTool({
    ...ctx,
    label: 'ts-prune',
    command,
    toolKey: 'ts-prune',
    noun: 'unused export',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'ts-prune')}`,
    parse: (raw) => parseTsPruneOutput(raw, cwd),
  });
}

async function runEslint(ctx: RunContext, fix = false): Promise<number> {
  const cwd = ctx.folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);
  const { eslintUseJson, revealOutput } = getConfig();
  const output = getOutputChannel(revealOutput);
  const label = fix ? 'ESLint (--fix)' : 'ESLint';
  const fixFlag = fix ? ' --fix' : '';
  const json = eslintUseJson ? ' --format json' : '';

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

  const eslintRun = (command: string): Promise<number> =>
    runTool({
      ...ctx,
      label,
      command,
      toolKey: 'eslint',
      noun: 'lint issue',
      packageManager: pm,
      installHint: 'Ensure ESLint is installed (run "Add ESLint to Angular project").',
      parse: (raw) => parseEslintOutput(raw, cwd),
      onRaw: tslintOnRaw,
    });

  // In a multi-project workspace, lint the *selected* project via the Angular CLI
  // so the picker actually scopes ESLint. The root "lint" script lints everything.
  const workspace = await readAngularWorkspace(cwd);
  const project = await getActiveProject(cwd);
  if (workspace && workspace.projects.length > 1 && project?.hasLintTarget) {
    output.appendLine(
      `\n${fix ? 'Fixing' : 'Linting'} Angular project "${project.name}" (ng lint ${project.name}${fixFlag}).`
    );
    return eslintRun(`${binRunner(pm)} ng lint ${project.name}${fixFlag}${json}`);
  }

  const contents = await readFileText(vscode.Uri.file(path.join(cwd, 'package.json')));
  if (!contents) {
    const message =
      'Angular Code Quality: package.json was not found in the workspace root. ESLint is typically run via an npm "lint" script.';
    output.appendLine(`\n${message}`);
    vscode.window.showErrorMessage(message);
    return RUN_FAILED;
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(contents);
  } catch {
    const message = 'Angular Code Quality: Could not parse package.json. Check that it is valid JSON.';
    output.appendLine(`\n${message}`);
    vscode.window.showErrorMessage(message);
    return RUN_FAILED;
  }

  if (pkg.scripts?.lint) {
    const lintArgs = [fixFlag.trim(), json.trim()].filter(Boolean).join(' ');
    return eslintRun(scriptCommand(pm, 'lint', lintArgs || undefined));
  }

  // No "lint" script (the default for `ng new` projects): use the Angular CLI's
  // lint target directly when angular.json has one.
  if (workspace?.projects.some((p) => p.hasLintTarget)) {
    output.appendLine(`\nNo "lint" script in package.json — using ng lint${fixFlag}.`);
    return eslintRun(`${binRunner(pm)} ng lint${fixFlag}${json}`);
  }

  const message =
    'Angular Code Quality: ESLint isn\'t set up — there is no "lint" script in package.json and no lint target in angular.json.';
  output.appendLine(`\n${message}`);
  setRunStatus('eslint', 'failed');
  if (!ctx.quiet || !notifiedFailure.has('eslint')) {
    notifiedFailure.add('eslint');
    // Not awaited: "Run all checks" must not stall until the toast is dismissed.
    void vscode.window
      .showWarningMessage(message, 'Add ESLint to Angular project')
      .then((choice) => {
        if (choice) {
          void addEslintToAngular();
        }
      });
  }
  return RUN_FAILED;
}

async function runStylelint(ctx: RunContext, fix = false): Promise<number> {
  const cwd = ctx.folder.uri.fsPath;
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
    ...ctx,
    label,
    command,
    toolKey: 'stylelint',
    noun: 'style issue',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'stylelint stylelint-config-standard-scss')}`,
    parse: (raw) => parseStylelintOutput(raw, cwd),
  });
}

/**
 * Run knip — the actively maintained successor to ts-prune/depcheck — over the
 * whole project. Reports unused files, exports, types, enum members, and
 * dependencies in one pass, into its own collection.
 */
async function runKnip(ctx: RunContext): Promise<number> {
  const cwd = ctx.folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);

  return runTool({
    ...ctx,
    label: 'knip',
    command: `${binRunner(pm)} knip --reporter json --no-exit-code`,
    toolKey: 'knip',
    noun: 'issue',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'knip')}`,
    parse: (raw) => parseKnipOutput(raw, cwd),
  });
}

/**
 * Lint Angular HTML templates with ESLint (via `@angular-eslint/template`).
 * Reports into its own `angular-template` collection so template findings never
 * overwrite the `.ts` ESLint results. Uses the same JSON-preferred parsing as
 * "Run ESLint". Scopes globs to the active project's source root unless the user
 * set `angularCodeQuality.template.globs` explicitly.
 */
async function runTemplateLint(ctx: RunContext): Promise<number> {
  const cwd = ctx.folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);
  const project = await getActiveProject(cwd);
  const { eslintUseJson } = getConfig();

  let templateGlobs = getConfig().templateGlobs;
  if (!isConfigExplicitlySet('template.globs') && project) {
    templateGlobs = templateGlobsForProject(project);
  }

  const globs = templateGlobs.map(shellArg).join(' ');
  const json = eslintUseJson ? ' --format json' : '';
  // --no-error-on-unmatched-pattern: a project with no matching templates is a
  // clean result, not a failure.
  const command = `${binRunner(pm)} eslint ${globs} --no-error-on-unmatched-pattern${json}`;

  return runTool({
    ...ctx,
    label: 'Angular templates',
    command,
    toolKey: 'angular-template',
    noun: 'template issue',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, '@angular-eslint/eslint-plugin-template @angular-eslint/template-parser')}`,
    parse: (raw) => parseEslintOutput(raw, cwd),
  });
}

/**
 * Run madge to find circular dependencies in the project's TypeScript sources.
 * Each cycle is reported as one finding on its first file, describing the loop.
 */
async function runMadge(ctx: RunContext): Promise<number> {
  const cwd = ctx.folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);
  const project = await getActiveProject(cwd);
  const sourceDir = project ? sourceDirForProject(project) : 'src';

  return runTool({
    ...ctx,
    label: 'madge (circular deps)',
    command: `${binRunner(pm)} madge --circular --extensions ts --json ${shellArg(sourceDir)}`,
    toolKey: 'madge',
    noun: 'circular dependency',
    packageManager: pm,
    installHint: `Install it with: ${addDevCommand(pm, 'madge')}`,
    parse: (raw) => parseMadgeOutput(raw, cwd),
  });
}

/** The runner for each tool. Adding a tool = an entry in tools.ts + a runner here. */
const TOOL_RUNNERS: Record<ToolKey, (ctx: RunContext) => Promise<number>> = {
  eslint: (ctx) => runEslint(ctx),
  stylelint: (ctx) => runStylelint(ctx),
  knip: runKnip,
  'angular-template': runTemplateLint,
  madge: runMadge,
  'ts-prune': runTsPrune,
  depcheck: runDepcheck,
};

/** Command entry point: run one tool in the resolved folder (with its own progress + toast). */
async function runSingleTool(key: ToolKey): Promise<void> {
  const folder = await resolveFolder();
  if (folder) {
    await TOOL_RUNNERS[key]({ folder });
  }
}

/**
 * Run ESLint / stylelint with `--fix` to auto-repair fixable problems, then let
 * the normal parse step refresh the Problems panel with whatever remains. Open
 * files are saved first so the tools don't overwrite unsaved editor changes on
 * disk; VS Code reloads the (now clean) files after they're fixed.
 */
async function fixTool(key: ToolKey): Promise<void> {
  if (key !== 'eslint' && key !== 'stylelint') {
    return;
  }
  const folder = await resolveFolder();
  if (!folder) {
    return;
  }
  await vscode.workspace.saveAll(false);
  if (key === 'eslint') {
    await runEslint({ folder }, true);
  } else {
    await runStylelint({ folder }, true);
  }
}

async function addEslintToAngular(): Promise<void> {
  const folder = await resolveFolder();
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

// --- Setup: detect and install tools ------------------------------------------

const INSTALL_TERMINAL_NAME = 'Angular Code Quality: Install tools';

async function hasStylelintConfig(cwd: string): Promise<boolean> {
  for (const name of STYLELINT_CONFIG_FILES) {
    if (await pathExists(vscode.Uri.file(path.join(cwd, name)))) {
      return true;
    }
  }
  const pkgText = await readFileText(vscode.Uri.file(path.join(cwd, 'package.json')));
  try {
    return Boolean(pkgText && (JSON.parse(pkgText) as { stylelint?: unknown }).stylelint);
  } catch {
    return false;
  }
}

/**
 * Install the given tools in a terminal (so the user sees progress and can answer
 * prompts). Plain tools go in one dev-install; ESLint uses `ng add
 * @angular-eslint/schematics`, which also wires up the lint target and config.
 * When stylelint is installed into a project without a stylelint config, a
 * minimal `.stylelintrc.json` is written so the first run works.
 */
async function installTools(keys: ToolKey[], folderArg?: vscode.WorkspaceFolder): Promise<void> {
  const folder = folderArg ?? (await resolveFolder());
  if (!folder || keys.length === 0) {
    return;
  }
  const cwd = folder.uri.fsPath;
  const pm = await resolvePackageManager(cwd);

  const plain = keys.filter((k) => !getTool(k).installViaNgAdd);
  const packages = [...new Set(plain.flatMap((k) => getTool(k).packages))];
  const commands: string[] = [];
  if (packages.length > 0) {
    commands.push(addDevCommand(pm, packages.join(' ')));
  }
  for (const key of keys.filter((k) => getTool(k).installViaNgAdd)) {
    commands.push(`${binRunner(pm)} ng add ${getTool(key).packages.join(' ')}`);
  }

  let wroteConfig = false;
  if (keys.includes('stylelint') && !(await hasStylelintConfig(cwd))) {
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(cwd, '.stylelintrc.json')),
        Buffer.from(DEFAULT_STYLELINT_CONFIG, 'utf8')
      );
      wroteConfig = true;
    } catch {
      // Not fatal: stylelint will report the missing config on its first run.
    }
  }

  vscode.window.terminals.find((t) => t.name === INSTALL_TERMINAL_NAME)?.dispose();
  const terminal = vscode.window.createTerminal({ name: INSTALL_TERMINAL_NAME, cwd });
  terminal.show();
  // Separate lines rather than `&&`, which Windows PowerShell 5.1 doesn't support;
  // the shell runs them one after another.
  for (const command of commands) {
    terminal.sendText(command);
  }

  const names = keys.map((k) => getTool(k).label).join(', ');
  vscode.window.showInformationMessage(
    `Angular Code Quality: installing ${names} in the terminal` +
      (wroteConfig ? ' (and created .stylelintrc.json)' : '') +
      '. The Code Quality view updates when it finishes.'
  );
}

/**
 * "Install / check tools…": show which tools are missing in this project and
 * install the ones the user picks (recommended ones are pre-selected).
 */
async function setupTools(): Promise<void> {
  const folder = await resolveFolder();
  if (!folder) {
    return;
  }
  const state = installStateFn(folder.uri.fsPath);
  const missing = TOOLS.filter((t) => state(t.key) === 'missing');

  if (missing.length === 0) {
    const allUnknown = TOOLS.every((t) => state(t.key) === 'unknown');
    vscode.window.showInformationMessage(
      allUnknown
        ? 'Angular Code Quality: couldn\'t check which tools are installed (no node_modules, or Yarn Plug\'n\'Play). Run your package manager\'s install first.'
        : 'Angular Code Quality: every supported tool is installed ✓'
    );
    return;
  }

  const items = missing.map((t) => ({
    label: t.label,
    description: t.recommended ? 'recommended' : t.legacy ? 'legacy' : 'optional',
    detail: `${t.description} — ${t.installViaNgAdd ? 'ng add ' : ''}${t.packages.join(' ')}`,
    picked: Boolean(t.recommended),
    key: t.key,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Angular Code Quality: install tools',
    placeHolder: 'Pick the tools to install as devDependencies (recommended ones are pre-selected)',
  });
  if (picked && picked.length > 0) {
    await installTools(
      picked.map((p) => p.key),
      folder
    );
  }
}

const SETUP_PROMPT_SHOWN_KEY = 'angularCodeQuality.setupPromptShown';
const SETUP_PROMPT_NEVER_KEY = 'angularCodeQuality.setupPromptNever';

/**
 * First open of an Angular workspace: if recommended tools are missing, offer to
 * install them. Shown at most once per workspace, and never again after "Don't
 * show again".
 */
async function maybePromptSetup(folder: vscode.WorkspaceFolder): Promise<void> {
  const context = extensionContext;
  if (!context) {
    return;
  }
  if (
    context.globalState.get<boolean>(SETUP_PROMPT_NEVER_KEY) ||
    context.workspaceState.get<boolean>(SETUP_PROMPT_SHOWN_KEY)
  ) {
    return;
  }
  if (!(await pathExists(vscode.Uri.file(path.join(folder.uri.fsPath, 'angular.json'))))) {
    return;
  }
  const missing = missingRecommended(installStateFn(folder.uri.fsPath));
  if (missing.length === 0) {
    return;
  }
  await context.workspaceState.update(SETUP_PROMPT_SHOWN_KEY, true);

  const names = missing.map((k) => getTool(k).label).join(', ');
  const choice = await vscode.window.showInformationMessage(
    `Angular Code Quality: ${names} ${missing.length === 1 ? "isn't" : "aren't"} installed in this project. Install to get the full set of checks?`,
    'Install…',
    "Don't show again"
  );
  if (choice === 'Install…') {
    await setupTools();
  } else if (choice === "Don't show again") {
    await context.globalState.update(SETUP_PROMPT_NEVER_KEY, true);
  }
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'angularCodeQuality');
}

async function openWalkthrough(): Promise<void> {
  const id = extensionContext?.extension.id ?? 'arul1998.angular-code-quality-toolkit';
  await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${id}#gettingStarted`, false);
}

// --- Run all checks / export -------------------------------------------------

interface RunAllOptions {
  /**
   * Quieter presentation for the run-on-activation path: a status-bar progress
   * spinner instead of a notification, and no final toast (a brief status-bar
   * message instead), so opening a workspace isn't interrupted by popups.
   */
  background?: boolean;
}

interface ChecksRun {
  selection: CheckSelection;
  counts: Map<ToolKey, number>;
  /** False when canceled by the user or superseded by a newer "Run all checks". */
  completed: boolean;
  /** True when a newer "Run all checks" for the same folder replaced this one. */
  superseded: boolean;
}

/**
 * Run the selected checks (see `selectChecks`) one after another in `folder`,
 * starting from a clean slate for those tools. A newer call for the same folder
 * cancels this one.
 */
async function runSelectedChecks(
  folder: vscode.WorkspaceFolder,
  progress: vscode.Progress<{ message?: string }>,
  userToken: vscode.CancellationToken
): Promise<ChecksRun> {
  const cwd = folder.uri.fsPath;
  const selection = checkSelectionFor(cwd);
  const counts = new Map<ToolKey, number>();

  const cts = new vscode.CancellationTokenSource();
  const userSub = userToken.onCancellationRequested(() => cts.cancel());
  const handle = runRegistry.begin(`${cwd}|*all`, () => cts.cancel());
  try {
    // Start from a clean slate so results from a previous run — including tools
    // that fail to launch this time and therefore never re-populate their own
    // collection — cannot linger in the Problems panel.
    clearFolderDiagnostics(cwd, selection.run);
    for (const key of selection.run) {
      if (cts.token.isCancellationRequested) {
        break;
      }
      progress.report({ message: getTool(key).label });
      counts.set(key, await TOOL_RUNNERS[key]({ folder, quiet: true, token: cts.token }));
    }
    const superseded = !handle.isCurrent();
    return { selection, counts, completed: !cts.token.isCancellationRequested, superseded };
  } finally {
    handle.end();
    userSub.dispose();
    cts.dispose();
  }
}

/** False (after telling the user, with an Install button) when no tool would run in `folder`. */
async function ensureChecksAvailable(folder: vscode.WorkspaceFolder, background: boolean): Promise<boolean> {
  if (checkSelectionFor(folder.uri.fsPath).run.length > 0) {
    return true;
  }
  const message = 'Angular Code Quality: no code-quality tools are installed in this project yet.';
  getOutputChannel(false).appendLine(`\n${message}`);
  if (background) {
    vscode.window.setStatusBarMessage(message, 5000);
  } else {
    void vscode.window.showInformationMessage(message, 'Install tools…').then((choice) => {
      if (choice) {
        void setupTools();
      }
    });
  }
  return false;
}

async function runAllChecks(opts: RunAllOptions = {}): Promise<void> {
  const folder = await resolveFolder({ quiet: opts.background });
  if (!folder) {
    return;
  }
  const output = getOutputChannel(getConfig().revealOutput);
  if (!(await ensureChecksAvailable(folder, opts.background ?? false))) {
    return;
  }
  output.appendLine('\n[Angular Code Quality] Running all checks (cleared previous results)…');

  await vscode.window.withProgress(
    {
      location: opts.background
        ? vscode.ProgressLocation.Window
        : vscode.ProgressLocation.Notification,
      title: 'Angular Code Quality: running all checks…',
      cancellable: true,
    },
    async (progress, token) => {
      const run = await runSelectedChecks(folder, progress, token);

      if (run.superseded) {
        output.appendLine('\n[Angular Code Quality] Restarted by a newer "Run all checks".');
        return;
      }
      if (!run.completed) {
        output.appendLine(
          '\n[Angular Code Quality] Canceled — the Problems panel shows only partial results from this run.'
        );
        vscode.window.showWarningMessage('Angular Code Quality — checks canceled (partial results).');
        return;
      }

      // Build a per-tool breakdown plus a grand total. A tool that failed to run
      // reports a negative count; surface that as "not run" rather than folding it into 0.
      let total = 0;
      const outputLines: string[] = [];
      const toastParts: string[] = [];
      for (const key of run.selection.run) {
        const label = getTool(key).label;
        const count = run.counts.get(key);
        if (count === undefined) {
          continue;
        }
        if (count === RUN_SUPERSEDED) {
          outputLines.push(`${label}: re-run separately (see its own result)`);
        } else if (count < 0) {
          outputLines.push(`${label}: not run (see output)`);
          toastParts.push(`${label} not run`);
        } else {
          total += count;
          outputLines.push(`${label}: ${pluralizeProblems(count)}`);
          toastParts.push(`${label} ${count}`);
        }
      }
      const notInstalled = run.selection.skipped
        .filter((s) => s.reason === 'not-installed')
        .map((s) => s.key);
      for (const skip of run.selection.skipped) {
        outputLines.push(
          `${getTool(skip.key).label}: skipped (${skip.reason === 'covered-by-knip' ? 'knip covers it' : 'not installed'})`
        );
      }

      // Full breakdown → output channel (multi-line survives there).
      output.appendLine('\n[Angular Code Quality] Scan completed.');
      for (const line of outputLines) {
        output.appendLine(`  ${line}`);
      }
      output.appendLine(`  Total: ${pluralizeProblems(total)}`);
      output.appendLine('See the Problems view (View → Problems) for details.');

      const missingNote =
        notInstalled.length > 0
          ? ` Not installed: ${notInstalled.map((k) => getTool(k).label).join(', ')}.`
          : '';
      const summaryText = `Angular Code Quality — scan completed: ${pluralizeProblems(total)} (${toastParts.join(', ')}).${missingNote}`;
      if (opts.background) {
        // Activation path: don't interrupt with a popup; the status-bar summary
        // already reflects the totals.
        vscode.window.setStatusBarMessage(summaryText, 5000);
        return;
      }
      // Concise single-line toast (VS Code collapses newlines in notifications).
      const actions = [total > 0 ? 'Show problems' : undefined, notInstalled.length > 0 ? 'Install missing' : undefined]
        .filter((a): a is string => Boolean(a));
      void vscode.window.showInformationMessage(summaryText, ...actions).then((choice) => {
        if (choice === 'Show problems') {
          void vscode.commands.executeCommand('workbench.actions.view.problems');
        } else if (choice === 'Install missing') {
          void installTools(notInstalled, folder);
        }
      });
    }
  );
}

/** vscode severity → the report's textual severity. */
function severityToText(severity: vscode.DiagnosticSeverity): IssueSeverity {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'info';
  }
}

/** Flatten this folder's current diagnostics into serializable report findings (paths folder-relative). */
function gatherReportFindings(cwd: string): ReportFinding[] {
  const findings: ReportFinding[] = [];
  for (const key of TOOL_KEYS) {
    const collection = collections.get(key);
    if (!collection) {
      continue;
    }
    collection.forEach((uri, diagnostics) => {
      if (!isInsideFolder(cwd, uri.fsPath)) {
        return;
      }
      const rel = path.relative(cwd, uri.fsPath) || uri.fsPath;
      for (const d of diagnostics) {
        findings.push({
          tool: DIAGNOSTIC_SOURCES[key],
          file: rel.split(path.sep).join('/'),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: severityToText(d.severity),
          message: d.message,
        });
      }
    });
  }
  return findings;
}

/**
 * CI-parity export: run the selected checks, then write every current finding
 * for the folder (including any results already present from other tools) to
 * `angular-code-quality-report.json` in the folder root and open it. The JSON
 * is deterministic so it can be committed or diffed in CI.
 */
async function exportReport(): Promise<void> {
  const folder = await resolveFolder();
  if (!folder) {
    return;
  }
  const cwd = folder.uri.fsPath;
  const output = getOutputChannel(getConfig().revealOutput);
  if (!(await ensureChecksAvailable(folder, false))) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Angular Code Quality: building report…',
      cancellable: true,
    },
    async (progress, token) => {
      const run = await runSelectedChecks(folder, progress, token);
      if (!run.completed) {
        return;
      }

      const findings = gatherReportFindings(cwd);
      const report = buildReport(findings, {
        version: extensionVersion,
        generatedAt: new Date().toISOString(),
      });
      const json = JSON.stringify(report, null, 2) + '\n';
      const reportUri = vscode.Uri.file(path.join(cwd, 'angular-code-quality-report.json'));
      try {
        await vscode.workspace.fs.writeFile(reportUri, Buffer.from(json, 'utf8'));
      } catch (err) {
        const message = `Angular Code Quality: could not write the report — ${
          err instanceof Error ? err.message : String(err)
        }`;
        output.appendLine(`\n${message}`);
        vscode.window.showErrorMessage(message);
        return;
      }

      output.appendLine(
        `\n[Angular Code Quality] Report written to ${reportUri.fsPath} (${report.summary.total} findings).`
      );
      const doc = await vscode.workspace.openTextDocument(reportUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(
        `Angular Code Quality — report saved: ${pluralizeProblems(report.summary.total)} across ${
          Object.keys(report.summary.byTool).length
        } tool(s).`
      );
    }
  );
}

/**
 * Clear only the diagnostics this extension created. Because each collection is
 * owned by this extension, `.clear()` never touches diagnostics contributed by
 * TypeScript, the Angular Language Service, the ESLint extension, or anything else.
 */
function clearAllDiagnostics(): void {
  for (const collection of collections.values()) {
    collection.clear();
  }
  runStatus.clear();
  updateSummaryStatusBar();
  vscode.window.setStatusBarMessage('Angular Code Quality: cleared all results.', 3000);
}

// --- Run on save ------------------------------------------------------------

/** Coalesce rapid saves (e.g. Save All, formatters re-saving) into one run. */
const RUN_ON_SAVE_DEBOUNCE_MS = 800;
let runOnSaveTimer: ReturnType<typeof setTimeout> | undefined;
/** Pending tools per workspace folder (keyed by folder URI). */
const pendingRunOnSave = new Map<string, { folder: vscode.WorkspaceFolder; tools: Set<ToolKey> }>();

async function flushRunOnSave(): Promise<void> {
  runOnSaveTimer = undefined;
  const batches = [...pendingRunOnSave.values()];
  pendingRunOnSave.clear();
  // Run sequentially so several tools don't contend for the same package manager.
  for (const { folder, tools } of batches) {
    for (const tool of tools) {
      await TOOL_RUNNERS[tool]({ folder, quiet: true });
    }
  }
}

/** Queue the given tools for `folder` and (re)start the debounce window. */
function scheduleRunOnSave(folder: vscode.WorkspaceFolder, tools: ToolKey[]): void {
  const key = folder.uri.toString();
  const pending = pendingRunOnSave.get(key) ?? { folder, tools: new Set<ToolKey>() };
  for (const tool of tools) {
    pending.tools.add(tool);
  }
  pendingRunOnSave.set(key, pending);
  if (runOnSaveTimer) {
    clearTimeout(runOnSaveTimer);
  }
  runOnSaveTimer = setTimeout(() => void flushRunOnSave(), RUN_ON_SAVE_DEBOUNCE_MS);
}

function handleDidSave(document: vscode.TextDocument): void {
  if (!getConfig().runOnSave || document.uri.scheme !== 'file') {
    return;
  }
  // Only react to files inside a workspace folder; run in *that* folder.
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return;
  }
  // Only re-run tools that "Run all checks" would run here, so a save never
  // triggers a tool that isn't installed or that the user turned off.
  const enabled = new Set(checkSelectionFor(folder.uri.fsPath).run);
  const tools = toolsForSavedFile(document.uri.fsPath).filter((t) => enabled.has(t));
  if (tools.length > 0) {
    scheduleRunOnSave(folder, tools);
  }
}

// --- Quick fixes ------------------------------------------------------------

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
    updateSummaryStatusBar();
  }
}

const REMOVE_UNUSED_EXPORT_COMMAND = 'angularCodeQualityToolkit.removeUnusedExport';

/**
 * Offers a "Remove export keyword" quick fix on each ts-prune "Unused export"
 * diagnostic whose declaration line is a safely-demotable form. The transform
 * itself lives (and is unit-tested) in codeActions.ts; here we only decide
 * whether to offer it, based on the current text of the diagnostic's line.
 */
class UnusedExportCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCES['ts-prune']) {
        continue;
      }
      const lineNo = diagnostic.range.start.line;
      if (lineNo >= document.lineCount) {
        continue;
      }
      const lineText = document.lineAt(lineNo).text;
      if (removeExportKeywordFromLine(lineText) === undefined) {
        continue;
      }
      const action = new vscode.CodeAction(
        'Remove export keyword (keep as file-private)',
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.command = {
        command: REMOVE_UNUSED_EXPORT_COMMAND,
        title: 'Remove export keyword',
        arguments: [document.uri, lineNo],
      };
      actions.push(action);
    }
    return actions;
  }
}

/**
 * Command bound to the quick fix: strip the `export` keyword from `lineNo` of
 * the document at `uri`, then drop the ts-prune diagnostic on that line so it
 * clears immediately. Recomputes the transform against the live text so it stays
 * correct even if the line moved since the diagnostic was produced.
 */
async function removeUnusedExport(uri: vscode.Uri, lineNo: number): Promise<void> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showErrorMessage(`Could not open ${uri.fsPath} to remove the export.`);
    return;
  }
  if (lineNo < 0 || lineNo >= document.lineCount) {
    return;
  }

  const line = document.lineAt(lineNo);
  const updated = removeExportKeywordFromLine(line.text);
  if (updated === undefined) {
    void vscode.window.showWarningMessage(
      "Couldn't remove the export automatically — this isn't a simple declaration. Edit it by hand."
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, line.range, updated);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage(`Failed to update ${uri.fsPath}.`);
    return;
  }

  const tsPruneCollection = collections.get('ts-prune');
  if (tsPruneCollection) {
    const remaining = (tsPruneCollection.get(uri) ?? []).filter(
      (d) => d.range.start.line !== lineNo
    );
    tsPruneCollection.set(uri, remaining);
    updateSummaryStatusBar();
  }
}

// --- Activation -------------------------------------------------------------

/** Accepts a ToolKey from a tree item / command argument; ignores anything else. */
function asToolKey(arg: unknown): ToolKey | undefined {
  return isToolKey(arg) ? arg : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  extensionVersion =
    (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? extensionVersion;

  for (const key of TOOL_KEYS) {
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

  // Sidebar: the "Tools" tree in the Code Quality activity-bar container.
  toolsTree = new ToolsTreeProvider(toolViewState);
  toolsView = vscode.window.createTreeView('angularCodeQuality.tools', {
    treeDataProvider: toolsTree,
  });
  context.subscriptions.push(toolsTree, toolsView);

  const cmd = (id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(`angularCodeQualityToolkit.${id}`, fn);

  context.subscriptions.push(
    cmd('runDepcheck', () => runSingleTool('depcheck')),
    cmd('runTsPrune', () => runSingleTool('ts-prune')),
    cmd('runEslint', () => runSingleTool('eslint')),
    cmd('runStylelint', () => runSingleTool('stylelint')),
    cmd('runKnip', () => runSingleTool('knip')),
    cmd('runTemplateLint', () => runSingleTool('angular-template')),
    cmd('runMadge', () => runSingleTool('madge')),
    cmd('exportReport', () => exportReport()),
    cmd('fixEslint', () => fixTool('eslint')),
    cmd('fixStylelint', () => fixTool('stylelint')),
    cmd('addEslintToAngular', () => addEslintToAngular()),
    cmd('runAllChecks', () => runAllChecks()),
    cmd('clearDiagnostics', () => clearAllDiagnostics()),
    cmd('selectProject', () => selectAngularProject()),
    cmd('setupTools', () => setupTools()),
    cmd('openSettings', () => openSettings()),
    cmd('openWalkthrough', () => openWalkthrough()),
    cmd('refreshTools', () => {
      refreshInstallStates();
      updateSummaryStatusBar();
    }),
    // Sidebar row actions (argument: the row's ToolKey).
    vscode.commands.registerCommand(RUN_TOOL_COMMAND, (key: unknown) => {
      const tool = asToolKey(key);
      return tool ? runSingleTool(tool) : undefined;
    }),
    vscode.commands.registerCommand(INSTALL_TOOL_COMMAND, (key: unknown) => {
      const tool = asToolKey(key);
      if (tool === 'eslint') {
        return addEslintToAngular();
      }
      return tool ? installTools([tool]) : undefined;
    }),
    cmd('fixTool', (key: unknown) => {
      const tool = asToolKey(key);
      return tool ? fixTool(tool) : undefined;
    }),
    vscode.commands.registerCommand(
      REMOVE_UNUSED_DEPENDENCY_COMMAND,
      (uri: vscode.Uri, depName: string) => removeUnusedDependency(uri, depName)
    ),
    vscode.commands.registerCommand(
      REMOVE_UNUSED_EXPORT_COMMAND,
      (uri: vscode.Uri, lineNo: number) => removeUnusedExport(uri, lineNo)
    ),
    // Quick fix: "Remove unused dependency" on depcheck findings in package.json.
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/package.json' },
      new UnusedDependencyCodeActionProvider(),
      { providedCodeActionKinds: UnusedDependencyCodeActionProvider.providedCodeActionKinds }
    ),
    // Quick fix: "Remove export keyword" on ts-prune findings in .ts files.
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/*.ts' },
      new UnusedExportCodeActionProvider(),
      { providedCodeActionKinds: UnusedExportCodeActionProvider.providedCodeActionKinds }
    ),
    // Run-on-save: re-run the relevant tool(s) when a file is saved (opt-in).
    vscode.workspace.onDidSaveTextDocument(handleDidSave),
    // Multi-root: the sidebar follows the folder of the file being edited.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) {
        setCurrentFolder(folder);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('angularCodeQuality')) {
        toolsTree?.refresh();
      }
    })
  );

  // Installs (from our terminal or the user's) change package.json / node_modules;
  // re-detect the tools shortly after so the sidebar updates by itself.
  let installRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleInstallRefresh = (): void => {
    if (installRefreshTimer) {
      clearTimeout(installRefreshTimer);
    }
    installRefreshTimer = setTimeout(() => refreshInstallStates(), 1500);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{package.json,node_modules/.package-lock.json,node_modules/.modules.yaml,node_modules/.yarn-state.yml}'
  );
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(scheduleInstallRefresh),
    watcher.onDidCreate(scheduleInstallRefresh),
    watcher.onDidDelete(scheduleInstallRefresh),
    vscode.window.onDidCloseTerminal((t) => {
      if (t.name === INSTALL_TERMINAL_NAME || t.name === 'Angular Code Quality: Add ESLint') {
        scheduleInstallRefresh();
      }
    }),
    { dispose: () => installRefreshTimer && clearTimeout(installRefreshTimer) }
  );

  // Initial state: pick the folder, show its project and tools, then (opt-in)
  // run all checks and (once per workspace) offer to install missing tools.
  void (async () => {
    const folder = await resolveFolder({ quiet: true });
    if (!folder) {
      return;
    }
    if (getConfig().runOnActivation) {
      void runAllChecks({ background: true });
    }
    await maybePromptSetup(folder);
  })();
}

export function deactivate(): void {
  if (runOnSaveTimer) {
    clearTimeout(runOnSaveTimer);
    runOnSaveTimer = undefined;
  }
  pendingRunOnSave.clear();
  runRegistry.cancelAll();
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
  runStatus.clear();
  installStates.clear();
  currentFolder = undefined;
  toolsTree = undefined;
  toolsView = undefined;
  extensionContext = undefined;
}
