import type {
  GovernanceBackend,
  GovernanceVerdict,
  PolicyRequest,
  PolicyRequestKind,
  RuleDescriptor,
  Violation,
  ViolationSeverity,
} from "@koi/core/governance-backend";
import { askId, GOVERNANCE_ALLOW } from "@koi/core/governance-backend";

export interface PatternMatch {
  readonly kind?: PolicyRequestKind | undefined;
  readonly toolId?: string | undefined;
  readonly model?: string | undefined;
}

export interface PatternRule {
  readonly match: PatternMatch;
  readonly decision: "allow" | "deny" | "ask";
  readonly rule?: string | undefined;
  readonly severity?: ViolationSeverity | undefined;
  readonly message?: string | undefined;
  /**
   * Prompt shown to the user when `decision: "ask"` matches. Forwarded as
   * the `prompt` field of the `ok:"ask"` verdict. Falls back to `message`
   * or a synthetic default when omitted.
   */
  readonly prompt?: string | undefined;
}

export interface PatternBackendConfig {
  readonly rules: readonly PatternRule[];
  readonly defaultDeny?: boolean | undefined;
}

function payloadObject(request: PolicyRequest):
  | {
      readonly toolId?: unknown;
      readonly model?: unknown;
    }
  | undefined {
  // PolicyRequest.payload is typed `JsonObject`, but a real caller may still
  // hand us `null` / an array / a primitive through an `as never` cast or
  // untyped RPC layer. Guard every property access so malformed payloads
  // return a structured `schema.invalid` verdict rather than throwing out of
  // the evaluator (governance-core treats thrown errors as POLICY_VIOLATION
  // already, but we want the cleaner, classified failure path).
  const payload = request.payload as unknown;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as { readonly toolId?: unknown; readonly model?: unknown };
}

function matches(rule: PatternRule, request: PolicyRequest): boolean {
  const { match } = rule;
  if (match.kind !== undefined && match.kind !== request.kind) return false;

  // Selectors are kind-scoped: `toolId` only applies to `tool_call` requests
  // with a string `toolId` payload, and `model` only applies to `model_call`
  // requests with a string `model` payload. Applying these selectors
  // unconditionally would mis-deny `custom:foo` kinds that happen to carry a
  // `toolId` key. Non-string / missing payload fields on the right kind are
  // handled by the separate schema check (fail-closed) so they don't
  // silently bypass deny rules.
  const payload = payloadObject(request);
  if (payload === undefined) {
    // Selectors can't match on a non-object payload. Leave it to the schema
    // check to convert this into a `schema.invalid` verdict for kinds that
    // require string selector fields.
    if (match.toolId !== undefined || match.model !== undefined) return false;
    return true;
  }
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
 * Non-object / null / array payloads on those kinds are equally malformed.
 * Falling through on a missing / wrongly-typed field would silently bypass
 * any tool- or model-scoped deny rule; we fail closed with a
 * `schema.invalid` violation instead.
 */
function findSchemaViolation(request: PolicyRequest): GovernanceVerdict | undefined {
  const payload = payloadObject(request);
  if (
    request.kind === "tool_call" &&
    (payload === undefined || typeof payload.toolId !== "string")
  ) {
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
  if (
    request.kind === "model_call" &&
    (payload === undefined || typeof payload.model !== "string")
  ) {
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

function describeMatch(match: PatternMatch): string {
  const selectors: readonly string[] = [
    ...(match.toolId !== undefined ? [`toolId=${match.toolId}`] : []),
    ...(match.model !== undefined ? [`model=${match.model}`] : []),
  ];
  if (match.kind !== undefined) {
    return selectors.length === 0 ? match.kind : `${match.kind}:${selectors.join(",")}`;
  }
  return selectors.length === 0 ? "*" : selectors.join(",");
}

// The "(no description)" literal is intentional user-facing fallback text.
// TUI renderers should display it verbatim — do NOT treat it as a sentinel.
function ruleToDescriptor(rule: PatternRule, idx: number): RuleDescriptor {
  // RuleDescriptor.effect is typed "allow" | "deny" | "advise". Map ask → advise
  // for the read-only /governance view; ask is a user-interactive variant of
  // advise in intent.
  const effect: RuleDescriptor["effect"] = rule.decision === "ask" ? "advise" : rule.decision;
  return {
    id: rule.rule ?? `pattern.${idx}`,
    description: rule.message ?? rule.rule ?? "(no description)",
    effect,
    pattern: describeMatch(rule.match),
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
    if (decision.rule.decision === "ask") {
      const prompt = decision.rule.prompt ?? decision.rule.message ?? `Approve ${request.kind}?`;
      return {
        ok: "ask",
        prompt,
        askId: askId(crypto.randomUUID()),
      };
    }
    return GOVERNANCE_ALLOW;
  }

  function describeRules(): readonly RuleDescriptor[] {
    const out = rules.map((r, i) => ruleToDescriptor(r, i));
    // `default-deny` is a reserved synthetic id. If a configured rule
    // happens to use the same id and defaultDeny is true, the output
    // will contain two entries with that id — the L0 contract does not
    // guarantee uniqueness, and this is cheaper than validation here.
    if (defaultDeny) {
      return [
        ...out,
        {
          id: "default-deny",
          description: "no rule matched and defaultDeny is enabled",
          effect: "deny",
          pattern: "*",
        },
      ];
    }
    return out;
  }

  return { evaluator: { evaluate }, describeRules };
}
