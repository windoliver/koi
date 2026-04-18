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

  // Selectors are kind-scoped: `toolId` only applies to `tool_call` requests
  // with a string `toolId` payload, and `model` only applies to `model_call`
  // requests with a string `model` payload. Applying these selectors
  // unconditionally would mis-deny `custom:foo` kinds that happen to carry a
  // `toolId` key. Non-string payload fields on the right kind are handled by
  // the separate schema check below (fail-closed) so they don't silently
  // bypass deny rules.
  if (match.toolId !== undefined) {
    if (request.kind !== "tool_call") return false;
    if (typeof payload.toolId !== "string" || payload.toolId !== match.toolId) return false;
  }
  if (match.model !== undefined) {
    if (request.kind !== "model_call") return false;
    if (typeof payload.model !== "string" || payload.model !== match.model) return false;
  }
  return true;
}

/**
 * Detect malformed payloads for kinds with required string fields. `tool_call`
 * must carry a string `toolId`, `model_call` must carry a string `model`.
 * Falling through on a missing/wrongly-typed field would silently bypass any
 * tool- or model-scoped deny rule; we fail closed with a `schema.invalid`
 * violation instead.
 */
function findSchemaViolation(request: PolicyRequest): GovernanceVerdict | undefined {
  const payload = request.payload as {
    readonly toolId?: unknown;
    readonly model?: unknown;
  };
  if (request.kind === "tool_call" && typeof payload.toolId !== "string") {
    return {
      ok: false,
      violations: [
        {
          rule: "schema.invalid",
          severity: "critical",
          message: "tool_call payload.toolId must be a string",
        },
      ],
    };
  }
  if (request.kind === "model_call" && typeof payload.model !== "string") {
    return {
      ok: false,
      violations: [
        {
          rule: "schema.invalid",
          severity: "critical",
          message: "model_call payload.model must be a string",
        },
      ],
    };
  }
  return undefined;
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
    // Fail-closed on malformed payloads BEFORE rule evaluation so a missing
    // or wrongly-typed toolId/model cannot slip past tool- or model-scoped
    // deny rules when `defaultDeny` is off.
    const schemaViolation = findSchemaViolation(request);
    if (schemaViolation !== undefined) return schemaViolation;

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
