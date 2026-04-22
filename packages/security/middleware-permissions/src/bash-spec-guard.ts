/**
 * bash-spec-guard — wraps @koi/bash-ast spec evaluation and enforces two
 * security properties:
 *
 * 1. **Exact-argv guard**: For any argv where the spec returns
 *    `kind: "partial" | "refused"`, an existing `allow` decision from a
 *    prefix `Run(...)` rule is downgraded to `ask` unless an explicit
 *    exact-argv rule allows the full command (detected by querying the
 *    base resource to see if the backend falls through to deny, then
 *    confirming the exact-argv resource returns allow).
 *
 * 2. **Semantic rule evaluation**: For `complete`/`partial` specs, evaluates
 *    `Write(path)`, `Read(path)`, and `Network(host)` rules against the
 *    spec's `writes`, `reads`, and `network[].host` fields.
 */

import {
  analyzeBashCommand,
  type CommandSemantics,
  type CommandSpec,
  evaluateBashCommand,
} from "@koi/bash-ast";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";

export type SpecGuardOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "spec-evaluated";
      readonly decision: PermissionDecision;
      readonly specKind: "complete" | "partial" | "refused";
    };

/** Return the stricter of two decisions: deny > ask > allow. */
function stricter(a: PermissionDecision, b: PermissionDecision): PermissionDecision {
  if (a.effect === "deny") return a;
  if (b.effect === "deny") return b;
  if (a.effect === "ask") return a;
  if (b.effect === "ask") return b;
  return a;
}

async function evaluateSemanticRules(
  semantics: CommandSemantics,
  resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>,
  baseQuery: PermissionQuery,
): Promise<PermissionDecision> {
  // let allows mutation to accumulate strictest result across checks
  let result: PermissionDecision = { effect: "allow" };

  for (const path of semantics.writes) {
    const d = await resolveQuery({ ...baseQuery, resource: path, action: "write" });
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  for (const path of semantics.reads) {
    const d = await resolveQuery({ ...baseQuery, resource: path, action: "read" });
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  for (const net of semantics.network) {
    // Use net.host (parsed URL.host) for Network rule matching, NOT net.target
    const d = await resolveQuery({ ...baseQuery, resource: net.host, action: "network" });
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  return result;
}

/**
 * Determine whether the backend has an explicit exact-argv allow rule, as
 * opposed to a generic prefix allow.
 *
 * A prefix-based backend (e.g. `Run(bash)`) returns `allow` for any resource
 * including the exact-argv. An exact-argv backend returns `deny` (fall-through)
 * for the base invoke resource but `allow` for the specific exact-argv resource.
 *
 * We detect this by re-querying the base resource: if the backend still returns
 * `allow`, it's a prefix/wildcard backend and the exact-argv allow is not
 * specific enough to override the spec guard. If the backend returns non-allow
 * for the base resource but allow for the exact-argv resource, the user has an
 * explicit exact-argv rule.
 */
async function hasExplicitExactArgvRule(
  exactResource: string,
  resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>,
  baseQuery: PermissionQuery,
): Promise<boolean> {
  const baseDecision = await resolveQuery(baseQuery);
  if (baseDecision.effect === "allow") {
    // Backend is prefix-based (allows everything including base resource)
    // → no explicit exact-argv rule
    return false;
  }
  // Backend has specific rules (denies base resource by default)
  // → check if exact-argv has an explicit allow
  const exactDecision = await resolveQuery({ ...baseQuery, resource: exactResource });
  return exactDecision.effect === "allow";
}

/**
 * Evaluate bash spec semantics against the permission backend.
 *
 * For `partial`/`refused` specs: enforces that any `allow` from a prefix
 * `Run(...)` rule is downgraded to `ask` unless an explicit exact-argv
 * `Run(...)` rule also allows the full command string. An exact-argv rule
 * is considered explicit when the backend falls through to deny on the
 * base invoke resource but returns allow for the exact-argv resource.
 *
 * For `complete`/`partial` specs with semantics: evaluates `Write(path)`,
 * `Read(path)`, and `Network(host)` rules against the spec's reported effects.
 *
 * For `too-complex`/`parse-unavailable` AST results, and for pipeline-like
 * simple commands (multiple commands in one analysis), returns
 * `{kind: "skipped"}`.
 */
export async function evaluateSpecGuard(opts: {
  readonly toolId: string;
  readonly rawCommand: string;
  readonly currentDecision: PermissionDecision;
  readonly resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>;
  readonly baseQuery: PermissionQuery;
  readonly registry: ReadonlyMap<string, CommandSpec>;
}): Promise<SpecGuardOutcome> {
  const { toolId, rawCommand, currentDecision, resolveQuery, baseQuery, registry } = opts;

  const analysis = await analyzeBashCommand(rawCommand);
  if (analysis.kind !== "simple") {
    return { kind: "skipped", reason: analysis.kind };
  }

  // Pipeline-like commands parsed as multiple simple commands cannot be
  // safely analyzed per-spec because piped stdout/stdin semantics are
  // not captured at the individual command level. Skip the guard.
  if (analysis.commands.length > 1) {
    return { kind: "skipped", reason: "multi-command" };
  }

  const cmd = analysis.commands[0];
  if (cmd === undefined) {
    return { kind: "skipped", reason: "empty-command-list" };
  }

  const specResult = evaluateBashCommand(
    { argv: cmd.argv, envVars: cmd.envVars, redirects: cmd.redirects },
    registry,
  );

  if (specResult.kind === "refused" || specResult.kind === "partial") {
    if (currentDecision.effect === "allow") {
      const exactResource = `${toolId}:${rawCommand.trim()}`;
      const hasExplicit = await hasExplicitExactArgvRule(exactResource, resolveQuery, baseQuery);

      if (!hasExplicit) {
        const label =
          specResult.kind === "refused"
            ? `${specResult.cause}: ${specResult.detail}`
            : specResult.reason;
        return {
          kind: "spec-evaluated",
          decision: {
            effect: "ask",
            reason: `Spec (${specResult.kind}: ${label}); exact-argv Run(...) rule required`,
          },
          specKind: specResult.kind,
        };
      }
    }

    if (specResult.kind === "partial") {
      const semanticDecision = await evaluateSemanticRules(
        specResult.semantics,
        resolveQuery,
        baseQuery,
      );
      return {
        kind: "spec-evaluated",
        decision: stricter(currentDecision, semanticDecision),
        specKind: "partial",
      };
    }

    return { kind: "spec-evaluated", decision: currentDecision, specKind: specResult.kind };
  }

  // complete — evaluate semantic rules only
  const semanticDecision = await evaluateSemanticRules(
    specResult.semantics,
    resolveQuery,
    baseQuery,
  );
  return {
    kind: "spec-evaluated",
    decision: stricter(currentDecision, semanticDecision),
    specKind: "complete",
  };
}
