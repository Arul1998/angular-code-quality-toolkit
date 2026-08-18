import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAngularJson,
  defaultProject,
  styleGlobsForProject,
} from '../angularWorkspace';

test('parseAngularJson returns null for non-Angular JSON', () => {
  assert.equal(parseAngularJson('{"foo":1}'), null);
  assert.equal(parseAngularJson('not json'), null);
});

test('parseAngularJson reads a single root project (architect)', () => {
  const content = JSON.stringify({
    projects: {
      'my-app': {
        projectType: 'application',
        root: '',
        sourceRoot: 'src',
        architect: {
          build: { options: { tsConfig: 'tsconfig.app.json' } },
          lint: { options: { lintFilePatterns: ['src/**/*.ts'] } },
        },
      },
    },
    defaultProject: 'my-app',
  });

  const ws = parseAngularJson(content)!;
  assert.equal(ws.projects.length, 1);
  const p = ws.projects[0];
  assert.equal(p.name, 'my-app');
  assert.equal(p.projectType, 'application');
  assert.equal(p.tsConfig, 'tsconfig.app.json');
  assert.equal(p.sourceRoot, 'src');
  assert.equal(p.hasLintTarget, true);
  assert.equal(defaultProject(ws)!.name, 'my-app');
});

test('parseAngularJson handles a monorepo and sorts apps before libs', () => {
  const content = JSON.stringify({
    projects: {
      'shared-lib': {
        projectType: 'library',
        root: 'projects/shared-lib',
        sourceRoot: 'projects/shared-lib/src',
        architect: { build: { options: { tsConfig: 'projects/shared-lib/tsconfig.lib.json' } } },
      },
      web: {
        projectType: 'application',
        root: 'apps/web',
        sourceRoot: 'apps/web/src',
        architect: {
          build: { options: { tsConfig: 'apps/web/tsconfig.app.json' } },
          lint: {},
        },
      },
    },
  });

  const ws = parseAngularJson(content)!;
  assert.equal(ws.projects.length, 2);
  // Application sorted first.
  assert.equal(ws.projects[0].name, 'web');
  assert.equal(ws.projects[1].name, 'shared-lib');
  // No defaultProject declared -> first (the app) is the default.
  assert.equal(defaultProject(ws)!.name, 'web');
  assert.equal(ws.projects[1].tsConfig, 'projects/shared-lib/tsconfig.lib.json');
});

test('parseAngularJson supports the Nx-style "targets" key', () => {
  const content = JSON.stringify({
    projects: {
      app: {
        projectType: 'application',
        root: 'apps/app',
        sourceRoot: 'apps/app/src',
        targets: { build: { options: { tsConfig: 'apps/app/tsconfig.app.json' } } },
      },
    },
  });
  const p = parseAngularJson(content)!.projects[0];
  assert.equal(p.tsConfig, 'apps/app/tsconfig.app.json');
});

test('parseAngularJson collects builder package names from targets', () => {
  const content = JSON.stringify({
    projects: {
      web: {
        projectType: 'application',
        root: 'apps/web',
        architect: {
          build: { builder: '@angular-devkit/build-angular:browser', options: {} },
          serve: { builder: '@angular-builders/custom-webpack:dev-server', options: {} },
          test: { builder: '@angular-devkit/build-angular:karma', options: {} },
        },
      },
    },
  });
  const ws = parseAngularJson(content)!;
  assert.deepEqual(
    ws.builders.sort(),
    ['@angular-builders/custom-webpack', '@angular-devkit/build-angular']
  );
});

test('styleGlobsForProject derives globs from sourceRoot', () => {
  assert.deepEqual(
    styleGlobsForProject({ name: 'web', root: 'apps/web', sourceRoot: 'apps/web/src', hasLintTarget: false }),
    ['apps/web/src/**/*.scss', 'apps/web/src/**/*.css']
  );
  // Falls back to root, then to 'src'.
  assert.deepEqual(
    styleGlobsForProject({ name: 'x', root: '', hasLintTarget: false }),
    ['src/**/*.scss', 'src/**/*.css']
  );
});
