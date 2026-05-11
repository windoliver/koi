import type { Severity } from "@koi/bash-classifier";
import { classifyCommand } from "@koi/bash-classifier";
import type { RiskAssessment, RiskInputs, RiskScorer, RiskTier } from "./risk-types.js";
import { compareRisk } from "./risk-types.js";

export interface DefaultRiskScorerOptions {
  /** Absolute path of project root. Resources inside score `low`; outside score `medium`. */
  readonly projectRoot: string;
}

const CRITICAL_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /^\/etc(?:\/|$)/,
];

const HIGH_PATH_PATTERNS: readonly RegExp[] = [/(?:^|\/)\.aws(?:\/|$)/, /(?:^|\/)\.config(?:\/|$)/];

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "fs_read",
  "glob",
  "Glob",
  "grep",
  "Grep",
  "ls",
  "ToolSearch",
]);
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multi-edit",
  "patch",
  "fs_write",
  "fs_edit",
]);

const SEVERITY_TO_TIER: Readonly<Record<Severity, RiskTier>> = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
};

/** Safe bash prefixes that are known-benign when the classifier returns severity: null. */
const SAFE_BASH_PREFIXES: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "pwd",
  "which",
  "echo",
  "head",
  "tail",
]);

function scorePath(
  resource: string | undefined,
  projectRoot: string,
): { readonly tier: RiskTier; readonly reason: string } {
  if (resource === undefined) return { tier: "low", reason: "no-resource" };
  for (const re of CRITICAL_PATH_PATTERNS) {
    if (re.test(resource)) return { tier: "critical", reason: `path-sensitive:${re.source}` };
  }
  for (const re of HIGH_PATH_PATTERNS) {
    if (re.test(resource)) return { tier: "high", reason: `path-config:${re.source}` };
  }
  if (resource.startsWith(projectRoot)) {
    return { tier: "low", reason: "in-project" };
  }
  return { tier: "medium", reason: "outside-project" };
}

function scoreBash(command: string | undefined): {
  readonly tier: RiskTier;
  readonly reason: string;
} {
  if (command === undefined || command.trim() === "") {
    return { tier: "high", reason: "bash:no-command" };
  }
  try {
    const result = classifyCommand(command);
    if (result.severity === null) {
      const head = result.prefix.split(/\s+/)[0] ?? "";
      if (SAFE_BASH_PREFIXES.has(head)) {
        return { tier: "low", reason: `bash:safe-prefix:${head}` };
      }
      return { tier: "medium", reason: `bash:unknown-prefix:${head}` };
    }
    const matchedId = result.matchedPatterns[0]?.id ?? "unknown";
    return { tier: SEVERITY_TO_TIER[result.severity], reason: `bash:${matchedId}` };
  } catch {
    return { tier: "high", reason: "bash:parse-error" };
  }
}

function scoreTool(
  toolId: string,
  bashCommand: string | undefined,
): { readonly tier: RiskTier; readonly reason: string } {
  if (READ_ONLY_TOOLS.has(toolId)) return { tier: "low", reason: `tool:${toolId}:read-only` };
  if (MUTATING_TOOLS.has(toolId)) return { tier: "medium", reason: `tool:${toolId}:mutate` };
  if (toolId === "bash") {
    const r = scoreBash(bashCommand);
    return { tier: r.tier, reason: r.reason };
  }
  return { tier: "medium", reason: `tool:${toolId}:unclassified` };
}

function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return compareRisk(a, b) >= 0 ? a : b;
}

export function createDefaultRiskScorer(opts: DefaultRiskScorerOptions): RiskScorer {
  return {
    score(inputs: RiskInputs): RiskAssessment {
      const path = scorePath(inputs.resource, opts.projectRoot);
      const tool = scoreTool(inputs.toolId, inputs.bashCommand);
      const tier = maxTier(path.tier, tool.tier);
      return { tier, reasons: [path.reason, tool.reason] };
    },
  };
}
