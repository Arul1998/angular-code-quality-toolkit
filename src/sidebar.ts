import * as vscode from 'vscode';
import { ToolKey } from './diagnostics';
import { InstallState, TOOLS, getTool } from './tools';

export type ToolRunStatus = 'idle' | 'running' | 'done' | 'failed';

/** What the sidebar needs to know about one tool (supplied by extension.ts). */
export interface ToolViewState {
  status: ToolRunStatus;
  install: InstallState;
  /** Current findings for the selected folder. */
  count: number;
  errors: number;
}

export const RUN_TOOL_COMMAND = 'angularCodeQualityToolkit.runTool';
export const INSTALL_TOOL_COMMAND = 'angularCodeQualityToolkit.installTool';

/**
 * The "Tools" tree in the Code Quality activity-bar view: one row per tool with
 * its live status (clean / N problems / running / failed / not installed).
 * Clicking a row runs the tool, or installs it when it's missing; inline
 * buttons (declared in package.json) offer run / fix / install.
 */
export class ToolsTreeProvider implements vscode.TreeDataProvider<ToolKey> {
  private readonly changed = new vscode.EventEmitter<ToolKey | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly getState: (key: ToolKey) => ToolViewState) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }

  getChildren(element?: ToolKey): ToolKey[] {
    if (element) {
      return [];
    }
    // Legacy tools (ts-prune, depcheck) are only shown once they're installed or
    // have been run, so new users see the recommended set.
    return TOOLS.filter((t) => {
      if (!t.legacy) {
        return true;
      }
      const state = this.getState(t.key);
      return state.install !== 'missing' || state.status !== 'idle' || state.count > 0;
    }).map((t) => t.key);
  }

  getTreeItem(key: ToolKey): vscode.TreeItem {
    const tool = getTool(key);
    const state = this.getState(key);
    const item = new vscode.TreeItem(tool.label, vscode.TreeItemCollapsibleState.None);
    item.id = key;

    const missing = state.install === 'missing';
    if (state.status === 'running') {
      item.description = 'running…';
      item.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (missing) {
      item.description = 'not installed';
      item.iconPath = new vscode.ThemeIcon('cloud-download');
    } else if (state.status === 'failed') {
      item.description = 'failed — see output';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else if (state.status === 'done' || state.count > 0) {
      if (state.count === 0) {
        item.description = 'clean';
        item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      } else {
        item.description = `${state.count} problem${state.count === 1 ? '' : 's'}`;
        item.iconPath =
          state.errors > 0
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'))
            : new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      }
    } else {
      item.description = 'not run';
      item.iconPath = new vscode.ThemeIcon('circle-large-outline');
    }

    // contextValue drives the inline buttons in package.json (view/item/context).
    const parts = ['tool', missing ? 'missing' : 'ready'];
    if (tool.fixable && !missing) {
      parts.push('fixable');
    }
    if (state.status === 'running') {
      parts.push('running');
    }
    item.contextValue = parts.join('-');

    const tooltip = new vscode.MarkdownString(`**${tool.label}** — ${tool.description}`);
    if (missing) {
      const how = `${tool.installViaNgAdd ? 'ng add ' : ''}${tool.packages.join(' ')}`;
      tooltip.appendMarkdown(`\n\nNot installed. Click to install (\`${how}\`).`);
    } else if (state.status !== 'running') {
      tooltip.appendMarkdown('\n\nClick to run.');
    }
    item.tooltip = tooltip;

    if (state.status !== 'running') {
      item.command = missing
        ? { command: INSTALL_TOOL_COMMAND, title: 'Install', arguments: [key] }
        : { command: RUN_TOOL_COMMAND, title: 'Run', arguments: [key] };
    }
    return item;
  }
}
