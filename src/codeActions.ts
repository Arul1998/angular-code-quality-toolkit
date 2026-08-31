/**
 * Pure logic backing the extension's quick fixes (VS Code "Code Actions").
 *
 * Free of any `vscode` import so it can be unit-tested with plain Node. The
 * extension host (extension.ts) provides the `CodeActionProvider` and applies
 * the resulting text edits.
 */

/** Prefix of the depcheck "unused dependency" diagnostic message (see diagnostics.ts). */
export const UNUSED_DEPENDENCY_PREFIX = 'Unused dependency: ';

/**
 * Pull the package name out of a depcheck "Unused dependency: <name>" message.
 * Returns undefined for any other message so the provider can ignore it.
 */
export function dependencyNameFromMessage(message: string): string | undefined {
  if (!message.startsWith(UNUSED_DEPENDENCY_PREFIX)) {
    return undefined;
  }
  const name = message.slice(UNUSED_DEPENDENCY_PREFIX.length).trim();
  return name.length > 0 ? name : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove a dependency's declaration line from a package.json string, keeping the
 * result valid JSON.
 *
 * Returns the new file content, or `undefined` when the dependency is not found
 * or appears on more than one line (ambiguous — safer to leave the file alone).
 *
 * Assumes the conventional one-key-per-line package.json layout. When the removed
 * entry was the last property in its object, the previous property's now-dangling
 * trailing comma is stripped so the JSON stays well-formed.
 */
export function removeDependencyFromPackageJson(
  content: string,
  depName: string
): string | undefined {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  // Match a JSON key line: optional indent, "name", colon — anywhere the exact
  // dependency name is declared as a key.
  const keyPattern = new RegExp(`^\\s*"${escapeRegExp(depName)}"\\s*:`);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keyPattern.test(lines[i])) {
      matches.push(i);
    }
  }
  if (matches.length !== 1) {
    return undefined;
  }

  const target = matches[0];
  const removedHadComma = lines[target].trim().endsWith(',');
  lines.splice(target, 1);

  // If the removed entry was the last property in its object (no trailing comma),
  // the preceding property line now carries a dangling comma before the closing
  // brace. Strip one trailing comma from the nearest previous non-blank line.
  if (!removedHadComma) {
    for (let i = target - 1; i >= 0; i--) {
      if (lines[i].trim().length === 0) {
        continue;
      }
      lines[i] = lines[i].replace(/,(\s*)$/, '$1');
      break;
    }
  }

  return lines.join(eol);
}
