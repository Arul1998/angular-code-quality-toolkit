/**
 * Package-manager detection and command construction. Pure (no `vscode`
 * imports) so it can be unit-tested with plain Node; the extension host reads the
 * lockfiles and passes their presence in.
 */

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'yarn', 'pnpm', 'bun'];

/** Which lockfiles are present in the workspace root. */
export interface LockfilePresence {
  /** package-lock.json / npm-shrinkwrap.json */
  npm: boolean;
  /** yarn.lock */
  yarn: boolean;
  /** pnpm-lock.yaml */
  pnpm: boolean;
  /** bun.lockb or bun.lock */
  bun: boolean;
}

/**
 * Pick the package manager from the lockfiles present. When several exist (a
 * misconfigured repo), the more specific managers win over npm. Defaults to npm
 * when nothing distinctive is found.
 */
export function detectPackageManager(locks: LockfilePresence): PackageManager {
  if (locks.pnpm) {
    return 'pnpm';
  }
  if (locks.yarn) {
    return 'yarn';
  }
  if (locks.bun) {
    return 'bun';
  }
  return 'npm';
}

/**
 * Command prefix to run a project-local CLI binary (the `npx` equivalent). These
 * favor the binary already installed in the workspace over fetching a random
 * copy. If the tool is not installed the command fails cleanly, which the
 * extension surfaces as a "tool not installed" error with an install hint.
 *
 * Note: `yarn exec` requires Yarn 2+ (Berry). On the EOL Yarn 1 (classic), set
 * `angularCodeQuality.packageManager` to `npm` to use `npx` instead.
 */
export function binRunner(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm exec';
    case 'yarn':
      return 'yarn exec';
    case 'bun':
      return 'bunx';
    default:
      return 'npx --yes';
  }
}

/** Command prefix to run a package.json script (the `npm run` equivalent). */
export function scriptRunner(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm run';
    case 'yarn':
      return 'yarn run';
    case 'bun':
      return 'bun run';
    default:
      return 'npm run';
  }
}

/** Build a "run this script, forwarding these args" command for the package manager. */
export function scriptCommand(pm: PackageManager, script: string, args?: string): string {
  const base = `${scriptRunner(pm)} ${script}`;
  if (!args) {
    return base;
  }
  // All four managers forward args after `--`.
  return `${base} -- ${args}`;
}

/** Build the "install these dev dependencies" hint appropriate to the package manager. */
export function addDevCommand(pm: PackageManager, packages: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm add --save-dev ${packages}`;
    case 'yarn':
      return `yarn add --dev ${packages}`;
    case 'bun':
      return `bun add --dev ${packages}`;
    default:
      return `npm install --save-dev ${packages}`;
  }
}
