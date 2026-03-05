# Changelog

All notable changes to the Angular Code Quality Toolkit extension are documented in this file.

## [0.0.2] - 2026-03-05

### Added

- Documentation: Added a ?Using this extension with CI? section (GitHub Actions example) to show how to run the same checks in CI.

### Changed

- Icon: Optimized the extension icon to reduce VSIX size.
- Marketplace metadata: Updated categories/keywords and ensured repository/homepage/bugs links are set.

---

## [0.0.1] - 2026-03-03

### Added

- depcheck command to find unused/missing npm dependencies.
- ts-prune command to find unused TypeScript exports.
- ESLint command (runs workspace `npm run lint`) and shows results in Output and Problems.
- ?Add ESLint to Angular project? command to help migrate from TSLint to ESLint.
- stylelint command to lint CSS/SCSS and show results in Output and Problems.
- In-editor diagnostics (Problems view + squiggles) to jump directly to file/line.
- Cross-platform path resolution so Problems entries open the correct files.

### Notes

- Extension does not bundle depcheck, ts-prune, ESLint, or stylelint; it runs them in the user's workspace (npx or npm scripts).
- Requires a workspace folder and (for full functionality) an Angular-style project with the relevant tools installed.