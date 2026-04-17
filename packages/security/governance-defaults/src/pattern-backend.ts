import type {
  GovernanceBackend,
  GovernanceVerdict,
  PolicyRequest,
  PolicyRequestKind,
  Violation,
  ViolationSeverity,
} from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";

export interface PatternMatch {
  readonly kind?: PolicyRequestKind | undefined;
  readonly toolId?: string | undefined;
  readonly model?: string | undefined;
}

export interface PatternRule {
  readonly match: PatternMatch;
  readonly decision: "allow" | "deny";
  readonly rule?: string | undefined;
  readonly severity?: ViolationSeverity | undefined;
  readonly message?: string | undefined;
}

export interface PatternBackendConfig {
  readonly rules: readonly PatternRule[];
  readonly defaultDeny?: boolean | undefined;
}

function matches(rule: PatternRule, request: PolicyRequest): boolean {
  const { match } = rule;
  if (match.kind !== undefined && match.kind !== request.kind) return false;

  const payload = request.payload as {
    readonly toolId?: unknown;
    readonly model?: unknown;
  };
  if (match.toolId !== undefined && payload.toolId !== match.toolId) return false;
  if (match.model !== undefined && payload.model !== match.model) return false;
  return true;
}

function violationFromRule(rule: PatternRule, idx: number): Violation {
  return {
    rule: rule.rule ?? `pattern.${idx}`,
    severity: rule.severity ?? "critical",
    message: rule.message ?? "denied by pattern backend",
  };
}

export function createPatternBackend(config: PatternBackendConfig): GovernanceBackend {
  const { rules, defaultDeny = false } = config;

  function evaluate(request: PolicyRequest): GovernanceVerdict {
    let decision: { rule: PatternRule; index: number } | undefined;
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (rule !== undefined && matches(rule, request)) {
        decision = { rule, index: i };
      }
    }

    if (decision === undefined) {
      if (defaultDeny) {
        return {
          ok: false,
          violations: [
            {
              rule: "default-deny",
              severity: "critical",
              message: "no rule matched and defaultDeny is enabled",
            },
          ],
        };
      }
      return GOVERNANCE_ALLOW;
    }

    if (decision.rule.decision === "deny") {
      return {
        ok: false,
        violations: [violationFromRule(decision.rule, decision.index)],
      };
    }
    return GOVERNANCE_ALLOW;
  }

  return { evaluator: { evaluate } };
}
