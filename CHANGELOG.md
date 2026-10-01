# Changelog

All notable changes to the Angular Code Quality Toolkit extension are documented in this file.

## [Unreleased]

## [0.9.0] - 2026-10-01

### Added

- **Built-in Angular checks.** New command **Find unused components, directives and pipes**. Nothing to install; it runs as part of **Run all checks** in any project with `@angular/core` and reports into its own `angular-quality-angular` source. A declaration is flagged only when its selector or pipe name is in no template **and** its class isn't referenced outside imports and `declarations` / `imports` / `exports` arrays **and** its file isn't lazy-loaded (`import('…')`) or re-exported. Decorators inside strings and comments are ignored. Opt-in `angularCodeQuality.angular.suggestOnPush` also suggests `ChangeDetectionStrategy.OnPush`.
- **Health report.** **Show health report** opens a page with a 1–100 score and A–E grade, per-tool counts with the change since the last run, a trend chart across recent runs, and the files with the most findings. **Export health report (HTML)** saves it as a standalone file.
- **Baseline mode.** **Create / update baseline** records the current findings in `.angular-code-quality-baseline.json` (commit it to share) and hides them, so only new problems show. Findings are matched by tool, file and message, not by line, so edits don't bring them back. **Remove baseline** undoes it.
- **Changed files only.** **Toggle: only show problems in changed files** (setting `angularCodeQuality.onlyChangedFiles`) limits findings to files edited, staged or untracked in git. `angularCodeQuality.changedFilesBase` (e.g. `origin/main`) also includes everything changed on the branch.
- **More quick fixes:**
  - **Fix all auto-fixable ESLint / stylelint problems in this file**: runs `--fix` on one file and shows what's left.
  - **Delete unused file** for knip's unused-file findings: asks first, then moves the file to the trash.
  - **Remove unused dependency** and **Remove export keyword** now also work on knip findings.
  - **Ignore "&lt;name&gt;" in depcheck results** adds a package to `angularCodeQuality.depcheck.ignores`.

## [0.8.0] - 2026-09-30

### Added

- **Code Quality sidebar.** A new Activity Bar view lists every tool with its live status (clean / N problems / running / failed / not installed). Click a row to run it, or to install it when it's missing. Inline buttons offer Run, Fix (`--fix` for ESLint / stylelint) and Install. The title bar has Run all checks, Refresh and Clear results; setup, project selection, report export and settings are in its `…` menu.
- **Install / check tools.** New command that detects which tools are installed in the project and installs the ones you pick as devDependencies, in a terminal, with your package manager. Recommended tools (ESLint via `ng add @angular-eslint/schematics`, stylelint, knip) are pre-selected. When stylelint is installed into a project with no stylelint config, a minimal `.stylelintrc.json` is created so the first run works.
- **First-run setup prompt.** Opening an Angular workspace where recommended tools are missing offers to install them, at most once per workspace, with a "Don't show again" option.
- **Getting-started walkthrough** (**Angular Code Quality: Get started**) covering install → run → sidebar → fix → run-on-save.
- **`angularCodeQuality.checks` setting.** Chooses which tools **Run all checks**, **Export report** and run-on-save use. Leave it empty (the default) for automatic selection: every installed tool, with **knip replacing ts-prune + depcheck** when it's installed. Tools that aren't installed are skipped instead of erroring, and the summary offers **Install missing**.
- **Actionable notifications.** "Not installed" errors have an **Install** button. Failures have **Show output** and **Open settings**. Scan results have **Show problems**.
- **Open settings** command.

### Changed

- **ESLint works without a `lint` script.** When `package.json` has no `lint` script (the default for `ng new` projects) but `angular.json` has a lint target, ESLint now runs through `ng lint`.
- Saving a `.html` file with run-on-save enabled also re-runs ESLint (`ng lint` usually covers templates). Run-on-save only triggers tools that **Run all checks** would run.
- Command Palette titles no longer repeat the category ("Angular Code Quality: Angular Code Quality: …").
- Background runs (run-on-save, Run all checks) report a missing or failing tool once, instead of on every save.

### Fixed

- **Run on save / run on activation now work without running a command first.** The extension activates by itself in workspaces with `angular.json` or `nx.json`. Previously it only loaded when you invoked a command, so these settings did nothing until then.
- **Stale findings are cleared.** Re-running a tool now removes findings from files that have since become clean. Before, they stayed in the Problems panel until **Run all checks** or **Clear results**.
- **No more duplicate concurrent runs.** Starting a tool that's already running in the same folder (for example run-on-save during **Run all checks**) cancels the older run instead of racing it. Starting **Run all checks** again restarts it.
- **Multi-root workspaces.** Commands now act on the folder of the active editor (or ask which folder), run-on-save runs in the saved file's folder, and each folder's results are kept separately. Previously everything used the first folder.
- **Reliable "not installed" detection.** The extension checks `node_modules` before running a tool, so detection no longer depends on the language of shell error messages. The old heuristic remains as a fallback for Yarn Plug'n'Play.
- A tool that fails (non-zero exit, no parseable output) keeps its previous findings instead of wiping them.

## [0.7.0] - 2026-09-02

### Added

- **knip support.** New command **Run knip** runs [knip](https://knip.dev) — the actively maintained successor to ts-prune/depcheck — and reports unused files, exports, types, enum members, and dependencies in a single pass. Findings land in the Problems panel under their own `angular-quality-knip` source, at their declared location where knip provides one.
- **Angular template linting.** New command **Lint Angular templates (.html)** runs ESLint over your HTML templates (via `@angular-eslint/template`) and reports into its own `angular-quality-template` source, so template findings never overwrite the `.ts` ESLint results. Saving a `.html` file re-runs it when **Run on save** is enabled. Scopes to the selected project's source root in a monorepo (override with `angularCodeQuality.template.globs`).
- **Circular-dependency detection (madge).** New command **Find circular dependencies (madge)** runs [madge](https://github.com/pahen/madge) over the project's TypeScript sources and reports each dependency cycle as one finding describing the full loop (e.g. `Circular dependency: a.ts → b.ts → a.ts`).
- **Quick fix: remove export keyword.** ts-prune **"Unused export"** findings on a simple declaration (`export function`/`const`/`class`/`interface`/`type`/`enum`/…) now offer a **Remove export keyword (keep as file-private)** code action. It drops only the `export` keyword — demoting the symbol rather than deleting it — and refuses re-export/`default` forms (`export {…}`, `export * …`, `export default …`) where that wouldn't be safe.
- **Export report (JSON).** New command **Export report (JSON)** runs the four core checks and writes every current finding to `angular-code-quality-report.json` in the workspace root (then opens it). The output is deterministic — sorted, with per-tool and per-severity roll-ups — so it can be committed or diffed for CI parity.
- **Run on activation.** New setting `angularCodeQuality.runOnActivation` (default off): run all checks once when the workspace opens, quietly (a status-bar spinner, no popups), so the Problems panel is populated without running a command by hand.

## [0.6.0] - 2026-08-31

### Added

- **Auto-fix commands for ESLint and stylelint.** New commands **Fix ESLint problems (--fix)** and **Fix stylelint problems (--fix)** run the tool with `--fix` to repair every auto-fixable issue, then re-scan so the Problems panel reflects only what's left. Open editors are saved first so `--fix` never overwrites unsaved changes on disk. Honors the same project scoping and package-manager detection as the corresponding "Run" commands.
- **Status-bar problem summary.** After a run, a status-bar item shows the total number of findings (e.g. `Quality: 6`) with a per-tool breakdown in its tooltip (`ESLint: 3 · stylelint: 1 · ts-prune: 2 · depcheck: 0`). Its icon reflects severity — error when any error-level problem exists, warning otherwise, a check when clean. Click it to open the Problems panel; "Clear results" hides it.

## [0.5.0] - 2026-08-31

### Added

- **Quick fix: remove unused dependency.** depcheck "Unused dependency: &lt;name&gt;" findings in `package.json` now offer a **Remove unused dependency "&lt;name&gt;"** code action (the lightbulb, or `Ctrl+.`/`Cmd+.`). It deletes the dependency's line — fixing the trailing comma when it was the last entry so the JSON stays valid — and clears the finding immediately. Skipped (with a note) when the same name appears more than once, so nothing is removed by guesswork.

## [0.4.0] - 2026-08-23

### Added

- **Run on save.** New setting `angularCodeQuality.runOnSave` (default off): when enabled, saving a file re-runs the relevant tool and refreshes the Problems panel in the background — saving a `.ts` file re-runs ESLint and ts-prune, a `.css`/`.scss` file re-runs stylelint, and `package.json` re-runs depcheck. Runs are quiet (no notifications) and debounced, so a "Save All" triggers a single run instead of one per file.

### Changed

- Declared `virtualWorkspaces: false` — the extension needs a real filesystem to run its command-line tools, so VS Code now correctly marks it unavailable in virtual workspaces (e.g. VS Code for the Web) instead of failing silently there.

## [0.3.1] - 2026-08-23

Same packaged extension as 0.3.0. Bumped because Open VSX treats versions as immutable — 0.3.0 was published, then deleted, and that identity cannot be reused.

### Added

- README: install from [Open VSX](https://open-vsx.org/extension/arul1998/angular-code-quality-toolkit) (Cursor, Windsurf, VSCodium, Gitpod) as well as the VS Code Marketplace.

## [0.3.0] - 2026-08-23

This release is about reliability and packaging — the extension's behavior is unchanged, but it ships smaller, activates faster, and is now covered by end-to-end tests on every commit.

### Changed

- **Bundled build.** The extension is now bundled with [esbuild](https://esbuild.github.io/) into a single minified `dist/extension.js` instead of shipping the raw compiled output. The packaged VSIX drops to ~20 KB of code (8 files total), which means a smaller download and faster activation.

### Added

- **Integration tests.** A real VS Code Extension Development Host now verifies, on every commit, that the extension activates, that all commands are registered and match `package.json`, and that "Clear results" runs cleanly — catching activation/packaging regressions the unit tests can't see.
- **Cross-platform CI.** GitHub Actions now type-checks, lints, unit-tests, and integration-tests on **Linux, Windows, and macOS**, then packages the VSIX and uploads it as a build artifact. (Integration tests run on Linux and Windows; macOS runs the unit suite, which exercises the same POSIX code path.)

### Fixed

- Documentation: corrected the default for `angularCodeQuality.revealOutputOnRun` in the README (it is `false`, matching the Problems-panel-first design).

## [0.2.0] - 2026-08-21

### Changed

- **Problems-panel-first UX.** Actionable findings surface primarily in **View → Problems** (and as editor squiggles), not as raw logs. Each finding now carries a **per-tool diagnostic source** so you can tell — and filter — which tool produced it: `angular-quality-eslint`, `angular-quality-stylelint`, `angular-quality-ts-prune`, `angular-quality-depcheck`.
  - Unused exports (ts-prune) and unused dependencies (depcheck) are now reported as **Warnings** (previously Information) so they show under the default Problems filters; ESLint/stylelint keep their reported severity.
  - Single-tool runs show a concise toast — `Code quality scan completed: N problems found (<tool>).` — instead of restating findings.
  - **Run all checks** now clears stale diagnostics up front (so a tool that fails to launch no longer leaves last run's problems behind) and finishes with a per-tool breakdown and a grand total.
  - The output channel is retained for command lines, raw tool output, failures, and install/config hints. Malformed tool output and unrepresentable file locations are handled without crashing the extension.

### Added

- **Angular-aware depcheck.** "Unused dependency" results now hide packages Angular uses implicitly — `@angular/*`, `@angular-devkit/*`, `zone.js`, `rxjs`, `tslib`, `typescript`, karma/jasmine, and any builder referenced in `angular.json` — so depcheck stops flagging framework packages as unused.
  - Toggle with `angularCodeQuality.depcheck.ignoreAngularImplicit` (default on).
  - Add your own patterns with `angularCodeQuality.depcheck.ignores` (supports `*` wildcards). Missing dependencies are never hidden.
- **`angular.json` project awareness.** In multi-project workspaces (monorepos, apps + libs), the extension reads `angular.json` and targets a selected project instead of assuming everything lives at the workspace root.
  - New command **"Select Angular project"** and a status-bar item showing the active project (click to change).
  - ts-prune now uses the active project's build `tsConfig` (e.g. `apps/web/tsconfig.app.json`) unless `angularCodeQuality.tsPrune.tsconfigPath` is set explicitly.
  - In multi-project workspaces, **ESLint lints the selected project** via `ng lint <project>` (when the project declares a lint target) instead of always running the root `lint` script.
  - stylelint's default globs are scoped to the active project's source root (e.g. `apps/web/src/**`) unless `angularCodeQuality.stylelint.globs` is set explicitly. When a `lint:styles`/`stylelint` npm script exists, that script's own patterns win (noted in the output channel).
  - Supports both Angular's `architect` and Nx-style `targets` keys; applications are offered before libraries.
  - "Add ESLint to Angular project" now runs `ng add` through the detected package manager (`pnpm exec` / `yarn exec` / `bunx` / `npx`) instead of always `npx`.
- **Package-manager support.** Tools and scripts now run with the workspace's package manager — npm, yarn, pnpm, or bun — detected automatically from the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`/`bun.lock`, `package-lock.json`).
  - New setting `angularCodeQuality.packageManager` (`auto` | `npm` | `yarn` | `pnpm` | `bun`) to override detection.
  - Binaries run via the manager's local runner (`npx --yes`, `pnpm exec`, `yarn exec`, `bunx`) so a project-local copy is preferred over fetching a random one.
  - "Tool not installed" hints now use the detected manager's add command (e.g. `pnpm add --save-dev …`).
  - The detected package manager is shown in the output channel for each run.

## [0.1.0] - 2026-08-18

### Added

- **Run all checks** command that runs depcheck, ts-prune, ESLint, and stylelint in sequence.
- **Clear results** command to remove all diagnostics contributed by the extension.
- **Settings** to configure behavior:
  - `angularCodeQuality.tsPrune.tsconfigPath`
  - `angularCodeQuality.stylelint.globs`
  - `angularCodeQuality.eslint.useJsonFormat`
  - `angularCodeQuality.stylelint.useJsonFormat`
  - `angularCodeQuality.revealOutputOnRun`
- Cancellable progress notifications while a tool runs.
- JSON output parsing for ESLint (`--format json`) and stylelint (`--formatter json`), with automatic fallback to text parsing.
- Unit tests for all output parsers (`npm test`) and self-linting via ESLint (`npm run lint`).
- `LICENSE` file (MIT).

### Changed

- Switched the process runner from `exec` to `spawn`, removing the 1 MB `maxBuffer` limit that could make large-project runs fail silently.
- Each tool now writes to its own diagnostic collection, so results from different tools no longer overwrite each other.
- Non-zero exit codes from depcheck/ESLint (which are normal when issues are found) no longer trigger a misleading warning notification.
- ts-prune results now skip exports marked `(used in module)` to avoid false positives.
- The "Add ESLint to Angular project" migration now runs in an integrated terminal so its interactive prompts work.
- Missing-tool errors now include an install hint per tool.
- Category `Formatters` replaced with `Other` (the extension does not format code).

### Fixed

- A command that exits non-zero with no parseable output (e.g. a lint script that rejects `--format json`) is now reported as a probable failure instead of a false "clean" result.
- Cancelling a run now terminates the whole process tree on both Windows (`taskkill /T`) and macOS/Linux (process-group signal), so the underlying CLI actually stops instead of leaking.
- ts-prune parsing now ignores TypeScript compiler errors (e.g. `error TS2307`), which previously masqueraded as unused-export diagnostics and hid tool failures.
- Tools are invoked with `npx --yes` so a missing binary reports an error instead of hanging on npm's interactive install prompt (no TTY).
- "Run all checks" now shows a single progress indicator and one final summary instead of a toast per tool.
- stylelint runs with `--allow-empty-input`, so projects with no matching style files no longer report a spurious failure.
- Corrected mojibake (garbled quote characters) in earlier changelog entries.

---

## [0.0.2] - 2026-03-05

### Added

- Documentation: Added a "Using this extension with CI" section (GitHub Actions example) to show how to run the same checks in CI.

### Changed

- Icon: Optimized the extension icon to reduce VSIX size.
- Marketplace metadata: Updated categories/keywords and ensured repository/homepage/bugs links are set.

---

## [0.0.1] - 2026-03-03

### Added

- depcheck command to find unused/missing npm dependencies.
- ts-prune command to find unused TypeScript exports.
- ESLint command (runs workspace `npm run lint`) and shows results in Output and Problems.
- "Add ESLint to Angular project" command to help migrate from TSLint to ESLint.
- stylelint command to lint CSS/SCSS and show results in Output and Problems.
- In-editor diagnostics (Problems view + squiggles) to jump directly to file/line.
- Cross-platform path resolution so Problems entries open the correct files.

### Notes

- Extension does not bundle depcheck, ts-prune, ESLint, or stylelint; it runs them in the user's workspace (npx or npm scripts).
- Requires a workspace folder and (for full functionality) an Angular-style project with the relevant tools installed.
