# Contributing

Thanks for your interest in improving the **Angular Code Quality Toolkit**! Bug reports, feature ideas, and pull requests are all welcome.

## Ways to help

- **Report a bug** or **request a feature** → open an [issue](https://github.com/Arul1998/angular-code-quality-toolkit/issues/new/choose). Real usage reports are the best roadmap signal.
- **Send a pull request** for a fix or a small, focused improvement.

## Development setup

You'll need **Node.js 20+** and npm.

```bash
git clone https://github.com/Arul1998/angular-code-quality-toolkit.git
cd angular-code-quality-toolkit
npm install
```

### Build

The extension is bundled with [esbuild](https://esbuild.github.io/) into `dist/extension.js`.

```bash
npm run compile      # type-check (tsc --noEmit) + bundle once
npm run watch        # rebuild on change while developing
npm run package      # production (minified) bundle, as shipped
```

### Run it

Press **F5** in VS Code to launch an **Extension Development Host**, then open an Angular project and try the commands from the Command Palette ("Angular Code Quality: …").

### Test & lint

```bash
npm test              # unit tests (node:test) for the pure logic
npm run test:integration   # launches a real VS Code host and checks activation + commands
npm run lint          # ESLint on the extension's own source
npm run check-types   # tsc --noEmit
```

## How the code is organized

Pure, vscode-free logic lives in small modules so it can be unit-tested without the extension host:

- `src/diagnostics.ts` — parsing tool output into diagnostics, per-tool sources.
- `src/packageManager.ts` — package-manager detection and command building.
- `src/angularWorkspace.ts` — reading `angular.json` (projects, builders).
- `src/runOnSave.ts` — mapping a saved file to the tools that should re-run.
- `src/codeActions.ts` — pure logic for quick fixes (e.g. removing an unused dependency from `package.json`).
- `src/extension.ts` — the VS Code wiring (commands, diagnostics collections, run pipeline).

Tests for the pure modules live in `src/test/*.test.ts` (run by `npm test`). Extension-host tests live in `src/integration/*.itest.ts` (run by `npm run test:integration`).

**Rule of thumb:** put new logic in a pure module with a unit test, and keep `extension.ts` to the thin vscode glue.

## Pull request guidelines

- Keep each PR focused on one change.
- Add or update a **unit test** for any pure logic you touch.
- Run `npm run lint`, `npm run check-types`, and `npm test` before pushing — CI runs these on Linux, Windows, and macOS.
- Add a short entry under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
- The extension runs command-line tools in the user's workspace; it does **not** bundle depcheck / ts-prune / ESLint / stylelint. Please keep that design (run the user's own tools) rather than adding heavy dependencies.

## Releasing (maintainers)

1. Bump `version` in `package.json` and move the `## [Unreleased]` notes under a new dated version in `CHANGELOG.md`.
2. Commit and push.
3. Tag the release — the release workflow builds the VSIX and publishes to the **VS Code Marketplace** and **Open VSX**, then attaches the VSIX to a GitHub Release:
   ```bash
   git tag v0.4.0 && git push origin v0.4.0
   ```
   (Requires the `VSCE_PAT` and `OVSX_PAT` repository secrets.)

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
