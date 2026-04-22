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
  initializeBashAst,
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
 * opposed to a prefix/glob allow (e.g. `bash:ssh*` or `bash:*`).
 *
 * Uses a canary-suffix technique: any prefix/glob rule that matched the
 * exact resource will also match `${exactResource}\x01__spec_guard_canary__`
 * because glob `*` compiles to `[^/]*` which matches any non-slash character
 * — including the appended canary bytes. An exact rule compiled to `^…$`
 * will NOT match the canary suffix. Therefore:
 *
 *   exact=allow  + canary=allow  → allow came from prefix/glob → not explicit
 *   exact=allow  + canary=deny   → allow came from exact rule  → explicit
 *   exact=deny                   → no matching allow at all    → not explicit
 *
 * The canary uses U+0001 (SOH) which cannot appear in a real bash command
 * string, so no legitimate rule pattern would ever match it on its own.
 */
async function hasExplicitExactArgvRule(
  exactResource: string,
  resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>,
  baseQuery: PermissionQuery,
): Promise<boolean> {
  const exactDecision = await resolveQuery({ ...baseQuery, resource: exactResource });
  if (exactDecision.effect !== "allow") {
    return false;
  }
  // Exact allows — distinguish exact rule from prefix/glob with a canary suffix.
  const canaryResource = `${exactResource}\x01__spec_guard_canary__`;
  const canaryDecision = await resolveQuery({ ...baseQuery, resource: canaryResource });
  // Canary also allows → rule is prefix/glob, not exact
  return canaryDecision.effect !== "allow";
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

  // Ensure the parser is ready. initializeBashAst() is idempotent — subsequent
  // calls return the cached promise and complete in O(1) once warm. Awaiting
  // here guarantees no parse-unavailable(not-initialized) denies from a
  // startup race between middleware construction and the first bash request.
  await initializeBashAst();

  const analysis = await analyzeBashCommand(rawCommand);
  if (analysis.kind === "parse-unavailable") {
    // bash-ast contract: callers MUST fail closed on parse-unavailable.
    // timeout/panic/over-length/not-initialized are all infrastructure failures
    // that prevent semantic analysis — deny to prevent bypass via parser DoS.
    return {
      kind: "spec-evaluated",
      decision: {
        effect: "deny",
        reason: `bash-ast unavailable (${analysis.cause}): fail-closed policy`,
      },
      specKind: "refused",
    };
  }
  if (analysis.kind !== "simple") {
    // too-complex: fall through to existing regex-based classifier
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
