# Changelog

All notable changes to the Angular Code Quality Toolkit extension are documented in this file.

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
