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
    output.appendLine(`Error: ${err.message}`);
  });

  child.on('exit', (code: number | null) => {
    output.appendLine(`\nProcess exited with code ${code ?? 'null'}.`);
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

      // Use ts-prune directly; most Angular apps have tsconfig.app.json
      const command = 'npx ts-prune -p tsconfig.app.json';
      runCommand(command, cwd, output);
    }
  );

  context.subscriptions.push(runDepcheck, runTsPrune);
}

export function deactivate(): void {
  // nothing to clean up
}

