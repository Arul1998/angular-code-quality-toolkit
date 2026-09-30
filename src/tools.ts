import * as path from 'path';
import { ToolKey } from './diagnostics';

/**
 * Static description of every tool the extension can run: how it is labelled in
 * the UI, which npm packages install it, and which package's presence means it
 * is installed. Pure and vscode-free so selection/detection logic is unit-tested.
 *
 * Adding a tool = one entry here + a runner in extension.ts.
 */
export interface ToolInfo {
  key: ToolKey;
  /** Short name shown in the sidebar, summaries and toasts. */
  label: string;
  /** One-line explanation shown in the sidebar and the setup picker. */
  description: string;
  /** Packages installed (as devDependencies) by "Install". */
  packages: string[];
  /** Package whose presence in node_modules means the tool is installed. */
  detectPackage: string;
  /** Recommended for every Angular project (pre-selected in the setup picker). */
  recommended?: boolean;
  /** Superseded by knip; still supported, but no longer recommended. */
  legacy?: boolean;
  /** Has a `--fix` command. */
  fixable?: boolean;
  /** Installed with `ng add <packages>` (an interactive schematic) rather than a plain dev install. */
  installViaNgAdd?: boolean;
}

export const TOOLS: readonly ToolInfo[] = [
  {
    key: 'eslint',
    label: 'ESLint',
    description: 'Lint issues in TypeScript',
    packages: ['@angular-eslint/schematics'],
    detectPackage: 'eslint',
    recommended: true,
    fixable: true,
    installViaNgAdd: true,
  },
  {
    key: 'stylelint',
    label: 'stylelint',
    description: 'Problems in CSS / SCSS',
    packages: ['stylelint', 'stylelint-config-standard-scss'],
    detectPackage: 'stylelint',
    recommended: true,
    fixable: true,
  },
  {
    key: 'knip',
    label: 'knip',
    description: 'Unused files, exports and dependencies',
    packages: ['knip'],
    detectPackage: 'knip',
    recommended: true,
  },
  {
    key: 'angular-template',
    label: 'Templates',
    description: 'ESLint over .html templates',
    packages: ['@angular-eslint/eslint-plugin-template', '@angular-eslint/template-parser'],
    detectPackage: '@angular-eslint/template-parser',
  },
  {
    key: 'madge',
    label: 'Circular deps',
    description: 'Import cycles (madge)',
    packages: ['madge'],
    detectPackage: 'madge',
  },
  {
    key: 'ts-prune',
    label: 'ts-prune',
    description: 'Unused exports (legacy — knip covers this)',
    packages: ['ts-prune'],
    detectPackage: 'ts-prune',
    legacy: true,
  },
  {
    key: 'depcheck',
    label: 'depcheck',
    description: 'Unused dependencies (legacy — knip covers this)',
    packages: ['depcheck'],
    detectPackage: 'depcheck',
    legacy: true,
  },
];

export const TOOL_KEYS: readonly ToolKey[] = TOOLS.map((t) => t.key);

export function getTool(key: ToolKey): ToolInfo {
  const tool = TOOLS.find((t) => t.key === key);
  if (!tool) {
    throw new Error(`Unknown tool: ${key}`);
  }
  return tool;
}

export function isToolKey(value: unknown): value is ToolKey {
  return typeof value === 'string' && (TOOL_KEYS as readonly string[]).includes(value);
}

/**
 * `installed`: found in a node_modules on the path up from the project.
 * `missing`: node_modules exist but the package isn't there.
 * `unknown`: can't tell (Yarn Plug'n'Play, or no node_modules at all) — callers
 * should just try running it.
 */
export type InstallState = 'installed' | 'missing' | 'unknown';

/**
 * Decide whether `pkg` is installed for the project at `startDir`, by looking for
 * `node_modules/<pkg>/package.json` in `startDir` and each ancestor (hoisted
 * monorepo installs). Locale-independent, and doesn't need to spawn anything.
 * `exists` is injected so this stays pure and testable.
 */
export function detectInstallState(
  startDir: string,
  pkg: string,
  exists: (p: string) => boolean
): InstallState {
  let dir = path.resolve(startDir);
  let sawNodeModules = false;
  for (;;) {
    if (exists(path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json'))) {
      return 'installed';
    }
    if (exists(path.join(dir, '.pnp.cjs')) || exists(path.join(dir, '.pnp.js'))) {
      return 'unknown';
    }
    if (exists(path.join(dir, 'node_modules'))) {
      sawNodeModules = true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return sawNodeModules ? 'missing' : 'unknown';
}

/** The tools "Run all checks" ran before tool selection existed (backward compatible fallback). */
const CLASSIC_CORE: readonly ToolKey[] = ['eslint', 'stylelint', 'ts-prune', 'depcheck'];

/** Tools picked automatically by "Run all checks" when installed (templates stay opt-in: `ng lint` usually covers them). */
const AUTO_CANDIDATES: readonly ToolKey[] = ['eslint', 'stylelint', 'knip', 'ts-prune', 'depcheck', 'madge'];

export type SkipReason = 'not-installed' | 'covered-by-knip';

export interface CheckSelection {
  run: ToolKey[];
  skipped: { key: ToolKey; reason: SkipReason }[];
}

/**
 * Choose what "Run all checks" runs.
 *
 * - `configured` non-empty (the `angularCodeQuality.checks` setting): exactly
 *   those tools, minus any that are definitely not installed.
 * - `configured` empty (default, "auto"): every installed tool. When knip is
 *   installed it replaces ts-prune + depcheck, which report the same things.
 *   Tools whose state is `unknown` (e.g. Yarn PnP) fall back to the classic four.
 *
 * The result is always in `TOOLS` order.
 */
export function selectChecks(
  configured: readonly string[],
  installState: (key: ToolKey) => InstallState
): CheckSelection {
  const run: ToolKey[] = [];
  const skipped: CheckSelection['skipped'] = [];
  const explicit = configured.filter(isToolKey);

  if (explicit.length > 0) {
    for (const key of TOOL_KEYS) {
      if (!explicit.includes(key)) {
        continue;
      }
      if (installState(key) === 'missing') {
        skipped.push({ key, reason: 'not-installed' });
      } else {
        run.push(key);
      }
    }
    return { run, skipped };
  }

  const knipInstalled = installState('knip') === 'installed';
  for (const key of TOOL_KEYS) {
    if (!AUTO_CANDIDATES.includes(key)) {
      continue;
    }
    const state = installState(key);
    const runnable = state === 'installed' || (state === 'unknown' && CLASSIC_CORE.includes(key));
    if (!runnable) {
      continue;
    }
    if (knipInstalled && (key === 'ts-prune' || key === 'depcheck')) {
      skipped.push({ key, reason: 'covered-by-knip' });
      continue;
    }
    run.push(key);
  }

  // Only mention missing tools a typical Angular project should have: ESLint,
  // stylelint, and an unused-code checker (knip, unless a legacy one ran).
  const unusedCodeCovered = run.includes('ts-prune') || run.includes('depcheck');
  for (const key of ['eslint', 'stylelint', 'knip'] as const) {
    if (installState(key) === 'missing' && !(key === 'knip' && unusedCodeCovered)) {
      skipped.push({ key, reason: 'not-installed' });
    }
  }
  return { run, skipped };
}

/** Recommended tools that are definitely missing — what the setup prompt offers. */
export function missingRecommended(installState: (key: ToolKey) => InstallState): ToolKey[] {
  return TOOLS.filter((t) => t.recommended && installState(t.key) === 'missing').map((t) => t.key);
}

/** Files that mean a stylelint config already exists (so setup must not write one). */
export const STYLELINT_CONFIG_FILES: readonly string[] = [
  '.stylelintrc',
  '.stylelintrc.json',
  '.stylelintrc.yaml',
  '.stylelintrc.yml',
  '.stylelintrc.js',
  '.stylelintrc.cjs',
  '.stylelintrc.mjs',
  'stylelint.config.js',
  'stylelint.config.cjs',
  'stylelint.config.mjs',
];

/** Minimal stylelint config written by setup when the project has none. */
export const DEFAULT_STYLELINT_CONFIG = '{\n  "extends": "stylelint-config-standard-scss"\n}\n';
