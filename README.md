# Angular Code Quality Toolkit

Run your Angular code-quality tools — **depcheck, ts-prune, ESLint, stylelint** — from inside VS Code, and see the results in the **Problems** panel like normal errors and warnings.

Click a problem → jump straight to the file and line. No reading raw logs.

![Demo: running all checks and jumping from a Problems-panel finding to the exact line](https://raw.githubusercontent.com/Arul1998/angular-code-quality-toolkit/main/assets/demo.gif)

<sub>Demo (representative). Runs depcheck, ts-prune, ESLint and stylelint, then surfaces every finding in the Problems panel.</sub>

**Works in** VS Code, and other VS Code–based editors — **Cursor, Windsurf, VSCodium, Gitpod** — via [Open VSX](https://open-vsx.org/extension/arul1998/angular-code-quality-toolkit). Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=arul1998.angular-code-quality-toolkit), or search **"Angular Code Quality Toolkit"** in your editor's Extensions view.

---

## What it does

- Finds **unused npm dependencies** (depcheck)
- Finds **unused TypeScript exports / dead code** (ts-prune)
- Finds **lint issues** in your `.ts` (ESLint)
- Finds **style issues** in your `.css` / `.scss` (stylelint)
- Shows everything in **View → Problems**, grouped by file, each tagged with the tool that found it:
  `angular-quality-eslint`, `angular-quality-stylelint`, `angular-quality-ts-prune`, `angular-quality-depcheck`

The extension does **not** bundle these tools. It runs the copies you already have in your project (via npm, yarn, pnpm, or bun — auto-detected from your lockfile).

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "Angular Code Quality".

| Command | What it does |
| --- | --- |
| **Run all checks** | Runs all four tools and shows a combined total. Start here. |
| **Run depcheck** | Unused / missing dependencies. |
| **Run ts-prune** | Unused TypeScript exports. |
| **Run ESLint** | Lint issues (uses your `lint` npm script or `ng lint`). |
| **Run stylelint** | CSS / SCSS issues. |
| **Fix ESLint problems (--fix)** | Auto-fix fixable ESLint issues, then re-scan and show what's left. |
| **Fix stylelint problems (--fix)** | Auto-fix fixable stylelint issues, then re-scan and show what's left. |
| **Add ESLint to Angular project** | Runs `ng add @angular-eslint/schematics` (use if you're still on TSLint). |
| **Select Angular project** | In a monorepo, choose which `angular.json` project to check. |
| **Clear results** | Removes only this extension's problems. Leaves TypeScript/ESLint-extension problems alone. |

---

## Where results show up

**Problems panel** (`View → Problems`) — this is the main place. Every finding appears as an Error, Warning, or Info with the correct file, line, and message. Click to open it.

- depcheck → unused deps point at `package.json`; missing deps point at the file that uses them.
- ts-prune → each unused export at its file and line.
- ESLint / stylelint → each issue at its exact `file:line:column`.

**Output panel** (`Angular Code Quality` channel) — kept for logs only: the command that ran, raw tool output, and errors like "tool not installed". You don't need it for the findings themselves.

When a run finishes you get a short notification, e.g. `Code quality scan completed: 14 problems found.`

---

## Quick fixes

Some findings can be fixed in place. On a depcheck **"Unused dependency"** problem in `package.json`, open the code-action menu (the lightbulb, or `Ctrl+.` / `Cmd+.`) and choose **Remove unused dependency "&lt;name&gt;"** — the extension deletes that line, keeps the JSON valid (trailing comma and all), and clears the finding. If the same name is declared twice, it leaves the file alone and tells you, so nothing is removed by guesswork.

For lint and style issues, **Fix ESLint problems (--fix)** and **Fix stylelint problems (--fix)** run the tool with `--fix` to auto-repair everything fixable, then re-scan so the Problems panel shows only what's left to fix by hand. Open editors are saved first so nothing unsaved is overwritten.

---

## Setup

You need an Angular workspace (a folder with `package.json`) and the tools you want to use installed in it:

```bash
npm install --save-dev depcheck ts-prune stylelint stylelint-config-standard-scss
```

For ESLint, your `package.json` should have a `lint` script (e.g. `"lint": "ng lint"`). If you're still on TSLint, run **Add ESLint to Angular project** first.

To catch unused variables and parameters, add the rule to your ESLint config so **Run ESLint** reports them:

```jsonc
{
  "rules": {
    "@typescript-eslint/no-unused-vars": "error"
  }
}
```

---

## Settings

**Settings → Extensions → Angular Code Quality Toolkit** (or `settings.json`):

| Setting | Default | What it does |
| --- | --- | --- |
| `angularCodeQuality.packageManager` | `auto` | `auto`, `npm`, `yarn`, `pnpm`, or `bun`. `auto` reads your lockfile. Yarn 1 users: set this to `npm`. |
| `angularCodeQuality.tsPrune.tsconfigPath` | `tsconfig.app.json` | Which tsconfig ts-prune uses. |
| `angularCodeQuality.stylelint.globs` | `["src/**/*.scss", "src/**/*.css"]` | Files stylelint checks when no style script exists. |
| `angularCodeQuality.eslint.useJsonFormat` | `true` | Ask ESLint for JSON output (more accurate). Turn off if your lint script rejects `--format`. |
| `angularCodeQuality.stylelint.useJsonFormat` | `true` | Ask stylelint for JSON output. |
| `angularCodeQuality.depcheck.ignoreAngularImplicit` | `true` | Hide false "unused" hits for packages Angular uses implicitly (`@angular/*`, `zone.js`, `rxjs`, `tslib`, `typescript`, karma/jasmine, builders). |
| `angularCodeQuality.depcheck.ignores` | `[]` | Extra packages to hide (`*` wildcard, e.g. `@my-scope/*`). |
| `angularCodeQuality.revealOutputOnRun` | `false` | Auto-open the Output channel on each run. Off by default — findings go to the Problems panel; enable this only to watch raw tool logs. |
| `angularCodeQuality.runOnSave` | `false` | Re-run the relevant checks automatically when you save a file (see below). |

---

## Run on save

Set `angularCodeQuality.runOnSave` to `true` and the extension re-runs the relevant tool whenever you save — the Problems panel stays current without you triggering **Run all checks** by hand:

| You save… | It re-runs |
| --- | --- |
| a `.ts` file | ESLint + ts-prune |
| a `.css` / `.scss` file | stylelint |
| `package.json` | depcheck |

Runs happen **quietly** in the background (no notifications) and are **debounced**, so a "Save All" or a formatter re-saving triggers a single run rather than one per file. Off by default.

---

## Good to know

- **Monorepo friendly.** Reads `angular.json`, supports apps + libraries and Nx-style `targets`. The active project shows in the status bar — click to switch.
- **Every run is cancellable** via its progress notification.
- **Each tool keeps its own results,** so running one tool never wipes another's, and re-running replaces stale results without duplicates.
- **Pairs well with CI.** Use the extension for fast feedback while editing, then run the same four commands in CI to enforce them on every PR:

  ```bash
  npx depcheck
  npx ts-prune -p tsconfig.app.json
  npm run lint
  npx stylelint "src/**/*.{css,scss}"
  ```

> Note on unused CSS: reliably detecting *unused* selectors under Angular's view encapsulation isn't practical, so stylelint here checks for rule violations and invalid CSS, not dead selectors.

---

## Developing this extension

```bash
npm install       # install deps
npm run compile   # build
npm run lint      # lint this extension's own code
npm test          # run the parser/diagnostic unit tests
```

Press `F5` in VS Code to launch an Extension Development Host, then open an Angular project and try the commands.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup, testing, and pull-request guide. Bug reports and feature ideas are welcome in [Issues](https://github.com/Arul1998/angular-code-quality-toolkit/issues/new/choose).
