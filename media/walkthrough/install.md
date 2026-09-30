# Install the tools

Angular Code Quality doesn't bundle any linters. It runs the ones installed in **your** project, so results always match your CI.

**Install / check tools** lists what's missing and installs your picks as devDependencies in a terminal, using your package manager (npm, yarn, pnpm or bun):

| Tool | Finds | |
| --- | --- | --- |
| **ESLint** | Lint issues in TypeScript | recommended (via `ng add @angular-eslint/schematics`) |
| **stylelint** | Problems in CSS / SCSS | recommended |
| **knip** | Unused files, exports and dependencies | recommended |
| Templates | ESLint over `.html` templates | optional |
| Circular deps | Import cycles (madge) | optional |

If the project has no stylelint config yet, a minimal `.stylelintrc.json` is created for you.
