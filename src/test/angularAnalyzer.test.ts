import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  SourceFile,
  analyzeAngular,
  findDeclarations,
  indexTemplates,
  maskNonCode,
  matchingBrace,
  referencedModules,
  selectorUsed,
  stripNonUsageReferences,
} from '../angularAnalyzer';

const root = path.resolve('/repo/src/app');
const file = (name: string, content: string): SourceFile => ({ path: path.join(root, name), content });

const unusedMessages = (files: SourceFile[]) =>
  analyzeAngular(files)
    .filter((i) => i.message.startsWith('Possibly unused'))
    .map((i) => i.message.split(':')[1].trim().split(' ')[0]);

test('matchingBrace skips braces inside strings and comments', () => {
  const text = `{ a: '}', b: "{", /* } */ c: \`}\` // }\n }`;
  assert.equal(matchingBrace(text, 0), text.length - 1);
});

test('findDeclarations reads kind, class, selector, pipe name and position', () => {
  const decls = findDeclarations(
    file(
      'x.ts',
      [
        "import { Component, Pipe } from '@angular/core';",
        '@Component({',
        "  selector: 'app-card',",
        '  template: `<div>{{ x }}</div>`,',
        '  changeDetection: ChangeDetectionStrategy.OnPush,',
        '})',
        'export class CardComponent {}',
        "@Pipe({ name: 'shout', standalone: true })",
        'export class ShoutPipe {}',
      ].join('\n')
    )
  );
  assert.equal(decls.length, 2);
  assert.deepEqual(
    { ...decls[0], file: undefined },
    {
      kind: 'component',
      className: 'CardComponent',
      file: undefined,
      line: 6,
      column: 13,
      selector: 'app-card',
      pipeName: undefined,
      setsChangeDetection: true,
      inlineTemplate: '<div>{{ x }}</div>',
    }
  );
  assert.equal(decls[1].kind, 'pipe');
  assert.equal(decls[1].pipeName, 'shout');
});

test('selectorUsed handles element, attribute, combined and unparseable selectors', () => {
  const index = indexTemplates(['<app-card [appTooltip]="t"></app-card>', '<button appPress *appIf="x">']);
  assert.ok(selectorUsed('app-card', index));
  assert.ok(selectorUsed('[appTooltip]', index));
  assert.ok(selectorUsed('button[appPress]', index));
  assert.ok(selectorUsed('[appIf]', index));
  assert.ok(selectorUsed('app-missing, [appPress]', index));
  assert.ok(!selectorUsed('app-missing', index));
  assert.ok(!selectorUsed('a[appPress]', index));
  assert.ok(selectorUsed('.some-class', index), 'class selectors are treated as used');
  assert.ok(selectorUsed('app-missing:not([x]), app-card', index));
});

test('stripNonUsageReferences removes imports and NgModule/standalone arrays only', () => {
  const stripped = stripNonUsageReferences(
    [
      "import {",
      "  FooComponent,",
      "} from './foo.component';",
      '@NgModule({ declarations: [FooComponent], imports: [BarModule], exports: [FooComponent], bootstrap: [AppComponent] })',
      "const routes = [{ path: '', component: FooComponent }];",
    ].join('\n')
  );
  assert.equal(stripped.match(/FooComponent/g)?.length, 1);
  assert.ok(stripped.includes('bootstrap: [AppComponent]'));
});

test('referencedModules resolves relative export-from specifiers', () => {
  const set = referencedModules([file('public-api.ts', "export * from './card/card.component';\nexport { X } from './lib';")]);
  assert.ok(set.has(path.join(root, 'card', 'card.component').toLowerCase()));
  assert.ok(set.has(path.join(root, 'lib', 'index').toLowerCase()));
});

test('analyzeAngular flags only declarations nothing uses', () => {
  const files = [
    file('app.component.ts', "@Component({ selector: 'app-root', templateUrl: './app.component.html' })\nexport class AppComponent {}"),
    file('app.component.html', '<app-used></app-used> {{ name | upper }} <div appHighlight></div>'),
    file('main.ts', "import { AppComponent } from './app/app.component';\nbootstrapApplication(AppComponent);"),
    file('used.component.ts', "@Component({ selector: 'app-used', template: '' })\nexport class UsedComponent {}"),
    file('orphan.component.ts', "@Component({ selector: 'app-orphan', template: '' })\nexport class OrphanComponent {}"),
    file('module.ts', "import { OrphanComponent } from './orphan.component';\n@NgModule({ declarations: [OrphanComponent, UsedComponent] })\nexport class M {}"),
    file('routed.component.ts', "@Component({ template: '' })\nexport class RoutedComponent {}"),
    file('routes.ts', "import { RoutedComponent } from './routed.component';\nexport const routes = [{ path: 'x', component: RoutedComponent }];"),
    file('lost.component.ts', "@Component({ template: '' })\nexport class LostComponent {}"),
    file('upper.pipe.ts', "@Pipe({ name: 'upper' })\nexport class UpperPipe {}"),
    file('lower.pipe.ts', "@Pipe({ name: 'lower' })\nexport class LowerPipe {}"),
    file('highlight.directive.ts', "@Directive({ selector: '[appHighlight]' })\nexport class HighlightDirective {}"),
    file('unused.directive.ts', "@Directive({ selector: '[appNope]' })\nexport class NopeDirective {}"),
    file('base.directive.ts', '@Directive()\nexport abstract class BaseDirective {}'),
    file('orphan.component.spec.ts', "import { OrphanComponent } from './orphan.component';\nTestBed.createComponent(OrphanComponent);"),
  ];
  assert.deepEqual(unusedMessages(files).sort(), ['LostComponent', 'LowerPipe', 'NopeDirective', 'OrphanComponent']);
});

test('analyzeAngular skips re-exported (library public API) declarations', () => {
  const files = [
    file('lib.component.ts', "@Component({ selector: 'lib-thing', template: '' })\nexport class LibThingComponent {}"),
    file('public-api.ts', "export * from './lib.component';"),
  ];
  assert.deepEqual(unusedMessages(files), []);
});

test('lazy-loaded default-export components count as used (loadComponent: () => import(…))', () => {
  const files = [
    file('docs.component.ts', "@Component({ selector: 'docs-docs', template: '' })\nexport default class DocsComponent {}"),
    file('list.component.ts', "@Component({ selector: 'app-list', template: '' })\nexport default class ListComponent {}"),
    file(
      'routes.ts',
      [
        "export const routes = [",
        "  { path: 'docs', loadComponent: () => import('./docs.component') },",
        "  { path: 'list', loadComponent: () =>",
        "      import(",
        "        './list.component'",
        "      ) },",
        '];',
      ].join('\n')
    ),
  ];
  assert.deepEqual(unusedMessages(files), []);
});

test('decorators inside strings and comments are not declarations', () => {
  const content = [
    'const exampleTs = `',
    '@Component({ imports: [X] })',
    'export class ExamplePage {}',
    '`;',
    "// @Pipe({ name: 'old' }) class OldPipe {}",
    "@Component({ selector: 'app-real', template: '' })",
    'export class RealComponent {}',
  ].join('\n');
  const decls = findDeclarations(file('x.ts', content));
  assert.deepEqual(decls.map((d) => d.className), ['RealComponent']);
  assert.equal(decls[0].line, 6);

  const masked = maskNonCode("a = 'x@Component({'; // @Pipe\nb");
  assert.equal(masked.length, "a = 'x@Component({'; // @Pipe\nb".length);
  assert.ok(!masked.includes('@'));
  assert.ok(masked.endsWith('\nb'));
});

test('analyzeAngular suggests OnPush only when asked', () => {
  const files = [
    file('a.component.ts', "@Component({ selector: 'app-a', template: '<app-b></app-b>' })\nexport class AComponent {}"),
    file('b.component.ts', "@Component({ selector: 'app-b', template: '', changeDetection: ChangeDetectionStrategy.OnPush })\nexport class BComponent {}"),
  ];
  assert.equal(analyzeAngular(files).filter((i) => i.message.includes('OnPush')).length, 0);
  const onPush = analyzeAngular(files, { suggestOnPush: true }).filter((i) => i.message.includes('OnPush'));
  assert.deepEqual(onPush.map((i) => i.message.split(' ')[1]), ['AComponent']);
  assert.equal(onPush[0].severity, 'info');
});
