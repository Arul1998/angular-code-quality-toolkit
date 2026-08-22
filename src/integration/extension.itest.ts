import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'arul1998.angular-code-quality-toolkit';

// The eight commands the extension contributes (must match package.json).
const CONTRIBUTED_COMMANDS = [
  'angularCodeQualityToolkit.runDepcheck',
  'angularCodeQualityToolkit.runTsPrune',
  'angularCodeQualityToolkit.runEslint',
  'angularCodeQualityToolkit.runStylelint',
  'angularCodeQualityToolkit.addEslintToAngular',
  'angularCodeQualityToolkit.runAllChecks',
  'angularCodeQualityToolkit.clearDiagnostics',
  'angularCodeQualityToolkit.selectProject',
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
