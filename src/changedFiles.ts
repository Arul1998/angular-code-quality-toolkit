import * as path from 'path';

/**
 * "Changed files only" scoping: which files differ from git, and filtering
 * findings down to them. Pure and vscode-free (unit-tested); extension.ts runs
 * the git commands and passes their output in.
 */

/**
 * The git invocations (argv, run in the workspace folder) whose outputs together
 * make up the changed-file set. All print paths relative to the repo root.
 *
 *  - working tree + index vs HEAD (staged and unstaged edits)
 *  - untracked, non-ignored files
 *  - with a base ref (e.g. `origin/main`): everything committed on this branch since it forked
 */
export function changedFilesGitCommands(baseRef: string): string[][] {
  const commands = [
    ['diff', '--name-only', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard', '--full-name'],
  ];
  const base = baseRef.trim();
  if (base) {
    commands.push(['diff', '--name-only', `${base}...HEAD`]);
  }
  return commands;
}

/** Turn `git … --name-only` output (repo-root-relative, one per line) into absolute paths. */
export function parseGitPaths(stdout: string, repoRoot: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => path.resolve(repoRoot, line));
}

/** Path key for comparisons: resolved, and lower-cased on case-insensitive platforms. */
export function pathKey(file: string, caseInsensitive: boolean): string {
  const resolved = path.resolve(file);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/** Keep only items whose file is in `changed` (a set of `pathKey`s). */
export function filterToChangedFiles<T extends { file: string }>(
  items: readonly T[],
  changed: ReadonlySet<string>,
  caseInsensitive: boolean
): { kept: T[]; hidden: number } {
  const kept = items.filter((item) => changed.has(pathKey(item.file, caseInsensitive)));
  return { kept, hidden: items.length - kept.length };
}
