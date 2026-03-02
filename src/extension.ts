import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Angular Code Quality Toolkit: No workspace folder is open.');
    return undefined;
  }
  return folders[0];
}

function createOutputChannel(): vscode.OutputChannel {
  const channel = vscode.window.createOutputChannel('Angular Code Quality');
  channel.show(true);
  return channel;
}

function runCommand(command: string, cwd: string, output: vscode.OutputChannel): void {
  output.appendLine(`> ${command}`);

  const child = exec(command, { cwd });

  child.stdout?.on('data', (data: string) => {
    output.append(data.toString());
  });

  child.stderr?.on('data', (data: string) => {
    output.append(data.toString());
  });

  child.on('error', (err: Error) => {
    output.appendLine(`Failed to start process: ${err.message}`);
    vscode.window.showErrorMessage(
      'Angular Code Quality Toolkit: Failed to start the underlying CLI process. ' +
        'Make sure the required tool is installed and available on your PATH.'
    );
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
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const runDepcheck = vscode.commands.registerCommand(
    'angularCodeQualityToolkit.runDepcheck',
    () => {
      const workspaceFolder = getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }

      const cwd = workspaceFolder.uri.fsPath;
      const output = createOutputChannel();
      output.appendLine(`Running depcheck in ${cwd}...\n`);

      runCommand('npx depcheck', cwd, output);
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
      const output = createOutputChannel();

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

        runCommand(command, cwd, output);
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
      const output = createOutputChannel();

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

          runCommand('npm run lint', cwd, output);
        });
    }
  );

  context.subscriptions.push(runDepcheck, runTsPrune, runEslint);
}

export function deactivate(): void {
  // nothing to clean up
}

