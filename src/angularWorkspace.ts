/**
 * Parsing of `angular.json` into a simple project list. Pure (no `vscode`
 * imports) so it can be unit-tested; the extension host reads the file and passes
 * its contents in.
 */

export type AngularProjectType = 'application' | 'library';

export interface AngularProject {
  name: string;
  projectType?: AngularProjectType;
  /** Project root relative to the workspace root ('' for a single-project app). */
  root: string;
  /** Source root relative to the workspace root, if declared. */
  sourceRoot?: string;
  /** tsConfig used by the build target, relative to the workspace root. */
  tsConfig?: string;
  /** Whether the project declares a lint target. */
  hasLintTarget: boolean;
}

export interface AngularWorkspace {
  projects: AngularProject[];
  defaultProject?: string;
  /** Builder/executor package names referenced by targets (e.g. @angular-devkit/build-angular). */
  builders: string[];
}

interface RawTarget {
  builder?: string;
  executor?: string;
  options?: {
    tsConfig?: string;
    [key: string]: unknown;
  };
}

interface RawProject {
  projectType?: string;
  root?: string;
  sourceRoot?: string;
  architect?: Record<string, RawTarget>;
  targets?: Record<string, RawTarget>;
}

interface RawAngularJson {
  projects?: Record<string, RawProject>;
  defaultProject?: string;
}

function pickBuildTarget(targets: Record<string, RawTarget>): RawTarget | undefined {
  if (targets.build) {
    return targets.build;
  }
  // Fall back to the first target that looks like a build.
  for (const [name, target] of Object.entries(targets)) {
    if (name.toLowerCase().includes('build')) {
      return target;
    }
  }
  return undefined;
}

/** Parse `angular.json` content into a normalized workspace. Returns null if it isn't valid. */
export function parseAngularJson(content: string): AngularWorkspace | null {
  let raw: RawAngularJson;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !raw.projects || typeof raw.projects !== 'object') {
    return null;
  }

  const projects: AngularProject[] = [];
  const builderSet = new Set<string>();
  for (const [name, proj] of Object.entries(raw.projects)) {
    if (!proj || typeof proj !== 'object') {
      continue;
    }
    const targets = proj.architect ?? proj.targets ?? {};
    for (const target of Object.values(targets)) {
      const ref = target?.builder ?? target?.executor;
      // "@angular-devkit/build-angular:browser" -> "@angular-devkit/build-angular"
      if (typeof ref === 'string' && ref.includes(':')) {
        builderSet.add(ref.slice(0, ref.lastIndexOf(':')));
      }
    }
    const build = pickBuildTarget(targets);
    const projectType =
      proj.projectType === 'application' || proj.projectType === 'library'
        ? proj.projectType
        : undefined;

    projects.push({
      name,
      projectType,
      root: typeof proj.root === 'string' ? proj.root : '',
      sourceRoot: typeof proj.sourceRoot === 'string' ? proj.sourceRoot : undefined,
      tsConfig: typeof build?.options?.tsConfig === 'string' ? build.options.tsConfig : undefined,
      hasLintTarget: Boolean(targets.lint),
    });
  }

  if (projects.length === 0) {
    return null;
  }

  // Applications first, then libraries, then alphabetical — so the natural
  // default selection is a buildable app.
  projects.sort((a, b) => {
    const rank = (p: AngularProject) => (p.projectType === 'application' ? 0 : p.projectType === 'library' ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return {
    projects,
    defaultProject: typeof raw.defaultProject === 'string' ? raw.defaultProject : undefined,
    builders: [...builderSet],
  };
}

/** Choose the best default project: the declared defaultProject, else the first application. */
export function defaultProject(workspace: AngularWorkspace): AngularProject | undefined {
  if (workspace.defaultProject) {
    const named = workspace.projects.find((p) => p.name === workspace.defaultProject);
    if (named) {
      return named;
    }
  }
  return workspace.projects[0];
}

/** Style globs for a project, derived from its sourceRoot (or root). */
export function styleGlobsForProject(project: AngularProject): string[] {
  const base = (project.sourceRoot || project.root || 'src').replace(/\/+$/, '');
  return [`${base}/**/*.scss`, `${base}/**/*.css`];
}
