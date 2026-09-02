import * as path from 'path';
import { ToolKey } from './diagnostics';

/**
 * Maps a saved file to the tools that should re-run for it (run-on-save):
 *
 *  - `package.json`   -> depcheck (dependency usage can change)
 *  - `*.ts`           -> ESLint + ts-prune (lint + unused-export analysis)
 *  - `*.html`         -> angular-template (ESLint over the template)
 *  - `*.css` / `*.scss` -> stylelint
 *
 * Returns an empty array for files no tool cares about (e.g. `.md`), so the
 * caller can cheaply skip scheduling a run. knip and madge are whole-project
 * scans, so they are intentionally never triggered by a single save.
 *
 * Pure and vscode-free so it can be unit-tested without the extension host.
 */
export function toolsForSavedFile(filePath: string): ToolKey[] {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'package.json') {
    return ['depcheck'];
  }
  const ext = path.extname(base);
  if (ext === '.ts') {
    return ['eslint', 'ts-prune'];
  }
  if (ext === '.html') {
    return ['angular-template'];
  }
  if (ext === '.css' || ext === '.scss') {
    return ['stylelint'];
  }
  return [];
}
