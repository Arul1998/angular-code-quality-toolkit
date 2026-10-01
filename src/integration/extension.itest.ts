import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'arul1998.angular-code-quality-toolkit';

// The commands the extension contributes (must match package.json).
const CONTRIBUTED_COMMANDS = [
  'angularCodeQualityToolkit.runDepcheck',
  'angularCodeQualityToolkit.runTsPrune',
  'angularCodeQualityToolkit.runEslint',
  'angularCodeQualityToolkit.runStylelint',
  'angularCodeQualityToolkit.runKnip',
  'angularCodeQualityToolkit.runTemplateLint',
  'angularCodeQualityToolkit.runMadge',
  'angularCodeQualityToolkit.exportReport',
  'angularCodeQualityToolkit.fixEslint',
  'angularCodeQualityToolkit.fixStylelint',
  'angularCodeQualityToolkit.addEslintToAngular',
  'angularCodeQualityToolkit.runAllChecks',
  'angularCodeQualityToolkit.clearDiagnostics',
  'angularCodeQualityToolkit.selectProject',
  'angularCodeQualityToolkit.removeUnusedDependency',
  'angularCodeQualityToolkit.removeUnusedExport',
  'angularCodeQualityToolkit.setupTools',
  'angularCodeQualityToolkit.openSettings',
  'angularCodeQualityToolkit.openWalkthrough',
  'angularCodeQualityToolkit.refreshTools',
  'angularCodeQualityToolkit.runTool',
  'angularCodeQualityToolkit.fixTool',
  'angularCodeQualityToolkit.installTool',
  'angularCodeQualityToolkit.runAngularChecks',
  'angularCodeQualityToolkit.showHealthReport',
  'angularCodeQualityToolkit.exportHtmlReport',
  'angularCodeQualityToolkit.createBaseline',
  'angularCodeQualityToolkit.clearBaseline',
  'angularCodeQualityToolkit.toggleChangedFilesOnly',
  'angularCodeQualityToolkit.fixFile',
  'angularCodeQualityToolkit.deleteUnusedFile',
  'angularCodeQualityToolkit.ignoreDependency',
];

suite('Angular Code Quality Toolkit — integration', () => {
  test('extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} should be installed in the test host`);
    await extension!.activate();
    assert.strictEqual(extension!.isActive, true, 'Extension should be active after activate()');
  });

  test('every contributed command is registered', async () => {
    // Activation is what registers the commands, so ensure it has run.
    await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of CONTRIBUTED_COMMANDS) {
      assert.ok(registered.has(command), `Command not registered: ${command}`);
    }
  });

  test('package.json command declarations match the registered commands', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const declared = (extension.packageJSON.contributes?.commands ?? []).map(
      (c: { command: string }) => c.command
    );
    assert.deepStrictEqual(
      [...declared].sort(),
      [...CONTRIBUTED_COMMANDS].sort(),
      'package.json commands should exactly match the expected set'
    );
  });

  test('activates on its own in Angular / Nx workspaces', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const events: string[] = extension.packageJSON.activationEvents ?? [];
    assert.ok(events.includes('workspaceContains:angular.json'));
    assert.ok(events.includes('workspaceContains:nx.json'));
  });

  test('contributes the Code Quality sidebar view and walkthrough', () => {
    const contributes = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
    const views = contributes.views?.angularCodeQuality ?? [];
    assert.ok(views.some((v: { id: string }) => v.id === 'angularCodeQuality.tools'));
    assert.ok(
      (contributes.walkthroughs ?? []).some((w: { id: string }) => w.id === 'gettingStarted')
    );
  });

  test('sidebar row commands ignore invalid arguments', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    for (const command of [
      'angularCodeQualityToolkit.runTool',
      'angularCodeQualityToolkit.fixTool',
      'angularCodeQualityToolkit.installTool',
      'angularCodeQualityToolkit.fixFile',
      'angularCodeQualityToolkit.deleteUnusedFile',
      'angularCodeQualityToolkit.ignoreDependency',
    ]) {
      await assert.doesNotReject(
        Promise.resolve(vscode.commands.executeCommand(command, 'not-a-tool'))
      );
    }
  });

  test('clearDiagnostics runs without throwing', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    // Should be safe to invoke with no workspace/tools present.
    await assert.doesNotReject(
      Promise.resolve(
        vscode.commands.executeCommand('angularCodeQualityToolkit.clearDiagnostics')
      )
    );
  });
});
