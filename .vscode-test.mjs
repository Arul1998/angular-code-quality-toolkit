import { defineConfig } from '@vscode/test-cli';

// Runs the compiled integration tests (src/integration/*.itest.ts -> out/integration)
// inside a real VS Code Extension Development Host. Unit tests live in src/test and
// run separately via `npm test` (node:test); this file drives Mocha for the host tests.
export default defineConfig({
  files: 'out/integration/**/*.itest.js',
  version: 'stable',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
