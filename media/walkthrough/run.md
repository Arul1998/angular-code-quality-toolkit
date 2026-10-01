# Run all checks

**Run all checks** runs every installed tool, one after another, and puts every finding in **View → Problems** as a normal error or warning. Click a finding to jump to its file and line.

- If knip is installed, it replaces ts-prune + depcheck (they'd report the same things).
- The built-in Angular checks (unused components, directives and pipes) always run in Angular projects. Nothing to install.
- Tools that aren't installed are skipped, and the summary offers to install them.
- To choose the tools yourself, set **`angularCodeQuality.checks`**.

The status bar shows the running total (for example `Quality: 6`). Hover it to see the count for each tool.
