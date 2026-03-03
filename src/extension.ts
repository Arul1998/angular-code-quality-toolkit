import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import {
  parseDepcheckOutput,
  parseTsPruneOutput,
  parseEslintOutput,
  parseStylelintOutput,
} from './diagnostics';

const DIAGNOSTIC_SOURCE = 'Angular Code Quality';

let outputChannel: vscode.OutputChannel | undefined;

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Angular Code Quality Toolkit: No workspace folder is open.');
    return undefined;
  }
  return folders[0];
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Angular Code Quality');
  }
  outputChannel.show(true);
  return outputChannel;
}

type OnDoneCallback = (stdout: string, stderr: string, exitCode: number | null) => void;

function runCommand(
  command: string,
  cwd: string,
  output: vscode.OutputChannel,
  onDone?: OnDoneCallback
): void {
  output.appendLine(`> ${command}`);

  let stdout = '';
  let stderr = '';

  const child = exec(command, { cwd });

  child.stdout?.on('data', (data: string) => {
    const s = data.toString();
    stdout += s;
    output.append(s);
  });

  child.stderr?.on('data', (data: string) => {
    const s = data.toString();
    stderr += s;
    output.append(s);
  });

  child.on('error', (err: Error) => {
    output.appendLine(`Failed to start process: ${err.message}`);
    vscode.window.showErrorMessage(
      'Angular Code Quality Toolkit: Failed to start the underlying CLI process. ' +
        'Make sure the required tool is installed and available on your PATH.'
    );
    onDone?.(stdout, stderr, null);
  });

  child.on('exit', (code: number | null, signal: string | null) => {
    if (signal) {
      output.appendLine(`\nProcess was terminated by signal ${signal}.`);
    } else {
      output.appendLine(`\nProcess exited with code ${code ?? 'null'}.`);
      if (code !== 0) {
        vscode.window.showWarningMessage(
          'Angular Code Quality Toolkit: The command completed with a non-zero exit code. ' +
            'Check the output channel for details.'
        );
      }
    }
    onDone?.(stdout, stderr, code);
  });
}

function setDiagnosticsFromEntries(
  collection: vscode.DiagnosticCollection,
  entries: { uri: vscode.Uri; diagnostic: vscode.Diagnostic }[]
): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const { uri, diagnostic } of entries) {
    diagnostic.source = DIAGNOSTIC_SOURCE;
    const key = uri.toString();
    const list = byUri.get(key) ?? [];
    list.push(diagnostic);
    byUri.set(key, list);
  }
  for (const [uriStr, diagnostics] of byUri) {
    collection.set(vscode.Uri.parse(uriStr), diagnostics);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  context.subscriptions.push(diagnosticCollection);

  const runDepcheck = vscode.commands.registerCommand(
    'angularCodeQualityToolkit.runDepcheck',
    () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }

      const cwd = workspaceFolder.uri.fsPath;
      const output = getOutputChannel();
      output.appendLine(`Running depcheck in ${cwd}...\n`);

      runCommand('npx depcheck --json', cwd, output, (stdout, stderr) => {
        const raw = stdout.trim() || stderr.trim();
        const packageJsonPath = path.join(cwd, 'package.json');
        vscode.workspace.fs
          .readFile(vscode.Uri.file(packageJsonPath))
          .then((buf) => buf.toString(), () => undefined)
          .then((packageJsonContent) => {
            const entries = parseDepcheckOutput(raw, cwd, packageJsonPath, packageJsonContent);
            setDiagnosticsFromEntries(diagnosticCollection, entries);
            if (entries.length > 0) {
              vscode.window.showInformationMessage(
                `Angular Code Quality: Found ${entries.length} issue(s). Check Problems view and editor.`
              );
            }
          });
      });
    }
  );

  const runTsPrune = vscode.commands.registerCommand(
    'angularCodeQualityToolkit.runTsPrune',
    () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }

      const cwd = workspaceFolder.uri.fsPath;
      const output = getOutputChannel();

      const defaultTsconfig = path.join(cwd, 'tsconfig.app.json');
      output.appendLine(`Running ts-prune in ${cwd}...\n`);
      output.appendLine('If needed, create a custom npm script for ts-prune in your project.');

      vscode.workspace.fs
        .stat(vscode.Uri.file(defaultTsconfig))
        .then(
          () => true,
          () => false
        )
        .then((exists) => {
        if (!exists) {
          const message =
            'Angular Code Quality Toolkit: tsconfig.app.json was not found in the workspace root. ' +
            'ts-prune works best when pointed at the tsconfig used for your Angular application.';
          output.appendLine(`${message}\n`);
          vscode.window.showWarningMessage(message);
        }

        const command = exists
          ? 'npx ts-prune -p tsconfig.app.json'
          : 'npx ts-prune';

        runCommand(command, cwd, output, (stdout, stderr) => {
          const raw = stdout.trim() || stderr.trim();
          const entries = parseTsPruneOutput(raw, cwd, workspaceFolder.uri);
          setDiagnosticsFromEntries(diagnosticCollection, entries);
          if (entries.length > 0) {
            vscode.window.showInformationMessage(
              `Angular Code Quality: Found ${entries.length} unused export(s). Check Problems view and editor.`
            );
          }
        });
        });
    }
  );

  const runEslint = vscode.commands.registerCommand(
    'angularCodeQualityToolkit.runEslint',
    () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }

      const cwd = workspaceFolder.uri.fsPath;
      const output = getOutputChannel();

      output.appendLine(`Running ESLint in ${cwd}...\n`);
      output.appendLine(
        'This uses the "lint" npm script from your Angular workspace (usually `npm run lint`).'
      );

      const packageJsonUri = vscode.Uri.file(path.join(cwd, 'package.json'));

      vscode.workspace.fs
        .readFile(packageJsonUri)
        .then(
          (buffer) => buffer.toString(),
          () => {
            const message =
              'Angular Code Quality Toolkit: package.json was not found in the workspace root. ' +
              'ESLint is typically configured via npm scripts there.';
            output.appendLine(`${message}\n`);
            vscode.window.showErrorMessage(message);
            return undefined as unknown as string;
          }
        )
        .then((contents) => {
          if (!contents) {
            return;
          }

          try {
            const pkg = JSON.parse(contents) as {
              scripts?: Record<string, string>;
            };

            if (!pkg.scripts || !pkg.scripts.lint) {
              const message =
                'Angular Code Quality Toolkit: No "lint" script found in package.json. ' +
                'Add a lint script (for example, using ESLint) to use this command.';
              output.appendLine(`${message}\n`);
              vscode.window.showWarningMessage(message);
              return;
            }
          } catch (err) {
            const message =
              'Angular Code Quality Toolkit: Could not parse package.json. ' +
              'Check that it is valid JSON.';
            output.appendLine(`${message}\n`);
            vscode.window.showErrorMessage(message);
            return;
          }

          runCommand('npm run lint', cwd, output, (stdout, stderr, exitCode) => {
            const raw = stdout.trim() || stderr.trim();
            const isTslintError =
              raw.includes('tslint') ||
              raw.includes('Cannot find builder') ||
              exitCode === 127;
            if (isTslintError && (raw.includes('tslint') || raw.includes('Cannot find builder'))) {
              vscode.window.showErrorMessage(
                'Angular Code Quality: This project still uses TSLint (removed in Angular 12+). ' +
                  'Migrate to ESLint with: ng add @angular-eslint/schematics'
              );
            }
            const entries = parseEslintOutput(raw, cwd, workspaceFolder.uri);
            setDiagnosticsFromEntries(diagnosticCollection, entries);
            if (entries.length > 0) {
              vscode.window.showInformationMessage(
                `Angular Code Quality: Found ${entries.length} lint issue(s). Check Problems view and editor.`
              );
            }
          });
        });
    }
  );

  const runAddEslint = vscode.commands.registerCommand(
    'angularCodeQualityToolkit.addEslintToAngular',
    () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }
      const cwd = workspaceFolder.uri.fsPath;
      const output = getOutputChannel();
      output.appendLine('Adding ESLint to Angular project (migrating from TSLint)...\n');
      output.appendLine('This runs: ng add @angular-eslint/schematics\n');
      runCommand('npx ng add @angular-eslint/schematics', cwd, output, () => {
        vscode.window.showInformationMessage(
          'Angular Code Quality: ESLint setup finished. Check the output channel. Run "Angular Code Quality: Run ESLint" after setup.'
        );
      });
    }
  );

  const runStylelint = vscode.commands.registerCommand(
    'angularCodeQualityToolkit.runStylelint',
    () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }
      const cwd = workspaceFolder.uri.fsPath;
      const output = getOutputChannel();
      output.appendLine(`Running stylelint in ${cwd}...\n`);

      const packageJsonUri = vscode.Uri.file(path.join(cwd, 'package.json'));
      vscode.workspace.fs
        .readFile(packageJsonUri)
        .then(
          (buffer) => buffer.toString(),
          () => undefined as unknown as string
        )
        .then((contents) => {
          let command: string;
          if (contents) {
            try {
              const pkg = JSON.parse(contents) as { scripts?: Record<string, string> };
              if (pkg.scripts && (pkg.scripts['lint:styles'] || pkg.scripts.stylelint)) {
                command = pkg.scripts['lint:styles'] ? 'npm run lint:styles' : 'npm run stylelint';
              } else {
                command = 'npx stylelint "src/**/*.scss" "src/**/*.css"';
              }
            } catch {
              command = 'npx stylelint "src/**/*.scss" "src/**/*.css"';
            }
          } else {
            command = 'npx stylelint "src/**/*.scss" "src/**/*.css"';
          }

          runCommand(command, cwd, output, (stdout, stderr, exitCode) => {
            const raw = stdout.trim() || stderr.trim();
            const entries = parseStylelintOutput(raw, cwd);
            setDiagnosticsFromEntries(diagnosticCollection, entries);

            if (entries.length > 0) {
              output.appendLine(`\n[Angular Code Quality] Found ${entries.length} style issue(s). Check the Problems view and editor.`);
              vscode.window.showInformationMessage(
                `Angular Code Quality: Found ${entries.length} style issue(s). Check Problems view and editor.`
              );
            } else {
              if (raw.length > 0) {
                output.appendLine('\n[Angular Code Quality] Stylelint finished. No issues reported in the output (or output format was not recognized).');
              } else {
                output.appendLine('\n[Angular Code Quality] Stylelint finished with no output. No style issues found—or no SCSS/CSS files were linted (check that src/**/*.scss and src/**/*.css exist and stylelint is installed).');
              }
            }
          });
        });
    }
  );

  context.subscriptions.push(runDepcheck, runTsPrune, runEslint, runAddEslint, runStylelint);
}

export function deactivate(): void {
  // nothing to clean up
}

