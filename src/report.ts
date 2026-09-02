/**
 * Pure builder for the machine-readable code-quality report (the `--ci` / export
 * command). Free of any `vscode` import so the report shape and the roll-up math
 * are unit-tested with plain Node; extension.ts gathers the current diagnostics,
 * calls this, and writes the JSON to disk.
 */

import { IssueSeverity } from './diagnostics';

/** A single finding, flattened from a vscode diagnostic for serialization. */
export interface ReportFinding {
  /** Diagnostic source, e.g. `angular-quality-eslint`. */
  tool: string;
  /** Absolute or workspace-relative file path (the caller decides). */
  file: string;
  /** 1-based line (human/CI friendly, unlike the 0-based internal value). */
  line: number;
  /** 1-based column. */
  column: number;
  severity: IssueSeverity;
  message: string;
}

export interface ReportSummary {
  total: number;
  errors: number;
  warnings: number;
  /** Count per tool source, only for tools that produced at least one finding. */
  byTool: Record<string, number>;
}

export interface QualityReport {
  tool: 'angular-code-quality-toolkit';
  version: string;
  generatedAt: string;
  summary: ReportSummary;
  findings: ReportFinding[];
}

/** Roll findings up into per-severity and per-tool totals. */
export function summarizeFindings(findings: ReportFinding[]): ReportSummary {
  const byTool: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    byTool[f.tool] = (byTool[f.tool] ?? 0) + 1;
    if (f.severity === 'error') {
      errors++;
    } else {
      warnings++;
    }
  }
  return { total: findings.length, errors, warnings, byTool };
}

/**
 * Assemble the full report object. `generatedAt` is injected (not read from the
 * clock) so the output is deterministic and testable. Findings are sorted by
 * file then line so diffs between runs are stable.
 */
export function buildReport(
  findings: ReportFinding[],
  meta: { version: string; generatedAt: string }
): QualityReport {
  const sorted = [...findings].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column
  );
  return {
    tool: 'angular-code-quality-toolkit',
    version: meta.version,
    generatedAt: meta.generatedAt,
    summary: summarizeFindings(sorted),
    findings: sorted,
  };
}
