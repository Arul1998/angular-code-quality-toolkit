# Changelog

All notable changes to the Angular Code Quality Toolkit extension are documented in this file.

## [0.0.1] - 2026-03-03

### Added

- **Run depcheck**: Find unused and missing npm dependencies; results in Output and Problems view with file/line.
- **Run ts-prune**: Find unused TypeScript exports; uses `tsconfig.app.json` when present; results in Problems view.
- **Run ESLint**: Run workspace `npm run lint`; parse output and show diagnostics in editor; TSLint migration hint when needed.
- **Add ESLint to Angular project**: Run `ng add @angular-eslint/schematics` to migrate from TSLint to ESLint.
- **Run stylelint**: Lint CSS/SCSS via npm script or default globs; results in Problems view.
- In-editor diagnostics: All tools report issues in the Problems panel and as squiggles in the editor.
- Path handling: Resolve file paths from project root so "Open" from Problems works on Windows and other platforms.

### Notes

- Extension does not bundle depcheck, ts-prune, ESLint, or stylelint; it runs them in the user's workspace (npx or npm scripts).
- Requires a workspace folder and (for full functionality) an Angular-style project with the relevant tools installed.
