# Keep results fresh

With **`angularCodeQuality.runOnSave`** turned on, saving a file quietly re-runs the tools that care about it (no popups):

| You save… | It re-runs |
| --- | --- |
| a `.ts` file | ESLint (and ts-prune, if you use it) |
| a `.html` file | ESLint (and template lint, if enabled) |
| a `.css` / `.scss` file | stylelint |
| `package.json` | depcheck (if you use it) |

Only tools that **Run all checks** would run are triggered. Whole-project scans (knip, madge) run only when you ask.

Prefer results the moment you open the project? Turn on **`angularCodeQuality.runOnActivation`**.
