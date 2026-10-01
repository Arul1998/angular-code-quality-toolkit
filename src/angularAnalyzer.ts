import * as path from 'path';
import { ParsedIssue } from './diagnostics';

/**
 * Built-in Angular checks (no external tool): components, directives and pipes
 * that nothing uses, and (opt-in) components that don't use OnPush change
 * detection. Pure and vscode-free: extension.ts reads the files and passes them in.
 *
 * "Unused" is deliberately conservative — a declaration is reported only when
 *  - its selector / pipe name appears in no template (.html files and inline
 *    `template:` strings), and
 *  - its class name is referenced nowhere else in non-test TypeScript, ignoring
 *    import statements and NgModule / standalone `declarations|imports|exports`
 *    arrays (which list a class without actually using it), and
 *  - its file isn't re-exported (`export … from`, a library's public API) or
 *    lazy-loaded (`import('…')`, e.g. `loadComponent` with a default export).
 * Anything it can't parse (complex selectors, class selectors) counts as used.
 */

export interface SourceFile {
  /** Absolute path. */
  path: string;
  content: string;
}

export type DeclarationKind = 'component' | 'directive' | 'pipe';

export interface AngularDeclaration {
  kind: DeclarationKind;
  className: string;
  file: string;
  /** Zero-based position of the class name. */
  line: number;
  column: number;
  selector?: string;
  pipeName?: string;
  /** The decorator sets `changeDetection` (OnPush or explicitly Default). */
  setsChangeDetection: boolean;
  inlineTemplate?: string;
}

export interface AngularAnalyzerOptions {
  /** Also suggest `ChangeDetectionStrategy.OnPush` for components that don't set `changeDetection`. */
  suggestOnPush?: boolean;
}

const DECORATOR = /@(Component|Directive|Pipe)\s*\(\s*\{/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Index of the `}` matching the `{` at `open`, skipping strings and comments; -1 if unbalanced. */
export function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip the string literal (template-literal `${}` nesting is rare in decorators).
      for (i++; i < text.length && text[i] !== ch; i++) {
        if (text[i] === '\\') {
          i++;
        }
      }
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Blank out string literals and comments (keeping length and newlines) so code
 * patterns inside them — e.g. example code in a template string — aren't
 * mistaken for real declarations. Single/double-quoted strings end at a newline,
 * which limits the damage if a regex literal containing a quote confuses it.
 */
export function maskNonCode(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') {
        out[k] = ' ';
      }
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      for (; j < text.length && text[j] !== ch; j++) {
        if (text[j] === '\\') {
          j++;
        } else if (ch !== '`' && text[j] === '\n') {
          break;
        }
      }
      blank(i + 1, j);
      i = j;
    }
  }
  return out.join('');
}

function stringProp(body: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`).exec(body);
  return match ? match[2] : undefined;
}

function lineCol(text: string, index: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart };
}

/** Find every @Component / @Directive / @Pipe class declared in a file. */
export function findDeclarations(file: SourceFile): AngularDeclaration[] {
  const { content } = file;
  const code = maskNonCode(content);
  const result: AngularDeclaration[] = [];
  DECORATOR.lastIndex = 0;
  let match: RegExpExecArray | null;
  // Match decorators on the masked text (so ones inside strings/comments are
  // skipped), then read the decorator body from the original text.
  while ((match = DECORATOR.exec(code))) {
    const open = match.index + match[0].length - 1;
    const close = matchingBrace(content, open);
    if (close === -1) {
      continue;
    }
    const body = content.slice(open, close + 1);
    // The decorated class follows the decorator's closing `)`.
    const after = content.slice(close, close + 400);
    const classMatch = /^\}\s*\)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(after);
    if (!classMatch) {
      continue;
    }
    const nameIndex = close + classMatch[0].length - classMatch[1].length;
    const kind = match[1].toLowerCase() as DeclarationKind;
    result.push({
      kind,
      className: classMatch[1],
      file: file.path,
      ...lineCol(content, nameIndex),
      selector: kind === 'pipe' ? undefined : stringProp(body, 'selector')?.trim(),
      pipeName: kind === 'pipe' ? stringProp(body, 'name')?.trim() : undefined,
      setsChangeDetection: /\bchangeDetection\s*:/.test(body),
      inlineTemplate: kind === 'component' ? stringProp(body, 'template') : undefined,
    });
    DECORATOR.lastIndex = close;
  }
  return result;
}

/** Everything a template "uses", pre-extracted once so each lookup is O(1). */
export interface TemplateIndex {
  /** Lower-cased element names (`<app-foo` → `app-foo`). */
  elements: Set<string>;
  /** Attribute-ish words (`appFoo`, `app-foo`, including `[appFoo]`, `*appIf`, `(appClick)`). */
  words: Set<string>;
  /** Names used after a `|`. */
  pipes: Set<string>;
}

export function indexTemplates(templates: readonly string[]): TemplateIndex {
  const elements = new Set<string>();
  const words = new Set<string>();
  const pipes = new Set<string>();
  for (const t of templates) {
    for (const m of t.matchAll(/<([a-zA-Z][\w-]*)/g)) {
      elements.add(m[1].toLowerCase());
    }
    for (const m of t.matchAll(/[A-Za-z_][\w-]*/g)) {
      words.add(m[0]);
    }
    for (const m of t.matchAll(/\|\s*([A-Za-z_$][\w$]*)/g)) {
      pipes.add(m[1]);
    }
  }
  return { elements, words, pipes };
}

/**
 * Is any part of a (comma-separated) selector used? Handles element selectors,
 * attribute selectors and combinations (`button[appFoo]`); anything else (class
 * selectors, pseudo-classes other than `:not`) is treated as used.
 */
export function selectorUsed(selector: string, index: TemplateIndex): boolean {
  const parts = selector.split(',').map((p) => p.replace(/:not\([^)]*\)/g, '').trim()).filter(Boolean);
  if (parts.length === 0) {
    return true;
  }
  for (const part of parts) {
    const m = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/.exec(part);
    if (!m) {
      return true;
    }
    const element = m[1];
    const attrs = [...m[2].matchAll(/\[\s*([^\]=~|^$*\s]+)/g)].map((a) => a[1]);
    if (!element && attrs.length === 0) {
      return true;
    }
    const elementOk = !element || index.elements.has(element.toLowerCase());
    if (elementOk && attrs.every((a) => index.words.has(a))) {
      return true;
    }
  }
  return false;
}

/** Remove what lists a class without using it: imports, and declarations/imports/exports arrays. */
export function stripNonUsageReferences(content: string): string {
  return content
    .replace(/^\s*import\s[\s\S]*?\sfrom\s*['"][^'"]+['"];?/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"];?/gm, '')
    .replace(/\b(declarations|imports|exports)\s*:\s*\[[^\]]*\]/g, '');
}

function withoutTsExtension(file: string): string {
  return file.replace(/\.ts$/, '').toLowerCase();
}

/**
 * Files (without extension, lower-cased) that are used as a whole module rather
 * than by class name: re-exported (`export … from '…'`, a library's public API)
 * or lazy-loaded (`import('…')`, e.g. `loadComponent` with a default export).
 */
export function referencedModules(files: readonly SourceFile[]): Set<string> {
  const result = new Set<string>();
  const patterns = [
    /\bexport\s+(?:\*|\{[^}]*\}|\*\s+as\s+\w+)\s+from\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];
  for (const f of files) {
    for (const pattern of patterns) {
      for (const m of f.content.matchAll(pattern)) {
        const resolved = path.resolve(path.dirname(f.path), m[1]);
        result.add(withoutTsExtension(resolved));
        result.add(withoutTsExtension(path.join(resolved, 'index')));
      }
    }
  }
  return result;
}

function isTestFile(file: string): boolean {
  return /\.(spec|test)\.ts$/.test(file);
}

const KIND_LABEL: Record<DeclarationKind, string> = {
  component: 'component',
  directive: 'directive',
  pipe: 'pipe',
};

export function analyzeAngular(files: readonly SourceFile[], options: AngularAnalyzerOptions = {}): ParsedIssue[] {
  const tsFiles = files.filter((f) => f.path.endsWith('.ts') && !f.path.endsWith('.d.ts') && !isTestFile(f.path));
  const htmlFiles = files.filter((f) => f.path.endsWith('.html'));

  const declarations = tsFiles.flatMap(findDeclarations);
  const templates = htmlFiles.map((f) => f.content);
  for (const d of declarations) {
    if (d.inlineTemplate) {
      templates.push(d.inlineTemplate);
    }
  }
  const templateIndex = indexTemplates(templates);

  // Identifier counts across non-test TypeScript, minus non-usage references.
  // The declaration itself (`class Foo`) contributes one occurrence.
  const identifierCounts = new Map<string, number>();
  for (const f of tsFiles) {
    for (const m of stripNonUsageReferences(f.content).matchAll(IDENTIFIER)) {
      identifierCounts.set(m[0], (identifierCounts.get(m[0]) ?? 0) + 1);
    }
  }
  const moduleReferenced = referencedModules(tsFiles);

  const issues: ParsedIssue[] = [];
  for (const d of declarations) {
    const position = {
      file: d.file,
      line: d.line,
      column: d.column,
      endColumn: d.column + d.className.length,
    };

    if (options.suggestOnPush && d.kind === 'component' && !d.setsChangeDetection) {
      issues.push({
        ...position,
        message: `Component ${d.className} uses default change detection — consider ChangeDetectionStrategy.OnPush`,
        severity: 'info',
      });
    }

    if (moduleReferenced.has(withoutTsExtension(d.file))) {
      continue;
    }
    if ((identifierCounts.get(d.className) ?? 0) > 1) {
      continue;
    }

    let usedInTemplate: boolean;
    let how: string;
    if (d.kind === 'pipe') {
      if (!d.pipeName) {
        continue;
      }
      usedInTemplate = templateIndex.pipes.has(d.pipeName);
      how = `pipe name "${d.pipeName}"`;
    } else if (d.selector) {
      usedInTemplate = selectorUsed(d.selector, templateIndex);
      how = `selector "${d.selector}"`;
    } else if (d.kind === 'directive') {
      // No selector: an abstract base / host directive, not usable in templates.
      continue;
    } else {
      usedInTemplate = false;
      how = 'no selector';
    }
    if (usedInTemplate) {
      continue;
    }

    issues.push({
      ...position,
      message:
        `Possibly unused ${KIND_LABEL[d.kind]}: ${d.className} (${how} is in no template, ` +
        'and the class is not referenced outside imports/declarations)',
      severity: 'info',
    });
  }
  return issues;
}
