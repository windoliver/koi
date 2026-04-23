/**
 * bash-spec-guard — wraps @koi/bash-ast spec evaluation and enforces two
 * security properties:
 *
 * 1. **Exact-argv guard**: For any argv where the spec returns
 *    `kind: "partial" | "refused"`, an existing `allow` decision from a
 *    prefix `Run(...)` rule is downgraded to `ask` unless an explicit
 *    exact-argv rule allows the full command (canary-suffix technique).
 *
 * 2. **Semantic rule evaluation**: For `complete`/`partial` specs, evaluates
 *    `Write(path)`, `Read(path)`, and `Network(host)` rules against the
 *    spec's `writes`, `reads`, and `network[].host` fields.
 *    Only runs when `backendSupportsDualKey: true` — requires a backend that
 *    marks fall-through denies with `IS_DEFAULT_DENY` so unmatched resources
 *    are not mistaken for explicit deny/ask rules.
 */

import {
  analyzeBashCommand,
  type CommandSemantics,
  type CommandSpec,
  evaluateBashCommand,
  initializeBashAst,
} from "@koi/bash-ast";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import { IS_DEFAULT_DENY } from "./classifier.js";

/**
 * Detect fall-through denies from both the internal IS_DEFAULT_DENY symbol
 * (set by createPatternPermissionBackend) and the public `default: true` /
 * `defaultDeny: true` fields that custom backends may set per the
 * PermissionBackend contract docs.
 */
function isDefaultDenyLike(decision: PermissionDecision): boolean {
  if (decision.effect !== "deny") return false;
  const d = decision as Record<string | symbol, unknown>;
  return d[IS_DEFAULT_DENY] === true || d.default === true || d.defaultDeny === true;
}

export type SpecGuardOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "spec-evaluated";
      readonly decision: PermissionDecision;
      readonly specKind: "complete" | "partial" | "refused";
    };

/**
 * Extract the bare hostname from a `URL.host` value (which may include port).
 *
 * `URL.host` includes port for non-default ports (e.g. "example.com:8443").
 * For IPv6 addresses the host is already bracketed (e.g. "[::1]" or "[::1]:8443").
 * We strip the trailing `:port` so that `Network("example.com")` rules match
 * regardless of what port the command targets.
 */
function extractHostname(host: string): string {
  if (!host.includes(":")) return host; // no port, already a hostname
  if (host.startsWith("[")) {
    // IPv6: "[::1]" or "[::1]:8443" — port follows the closing bracket
    const close = host.indexOf("]");
    return close !== -1 ? host.slice(0, close + 1) : host;
  }
  // Regular hostname with port: everything before the last colon
  const lastColon = host.lastIndexOf(":");
  return lastColon !== -1 ? host.slice(0, lastColon) : host;
}

/** Return the stricter of two decisions: deny > ask > allow. */
function stricter(a: PermissionDecision, b: PermissionDecision): PermissionDecision {
  if (a.effect === "deny") return a;
  if (b.effect === "deny") return b;
  if (a.effect === "ask") return a;
  if (b.effect === "ask") return b;
  return a;
}

/**
 * Evaluate semantic Write/Read/Network rules for a command's effects.
 *
 * Only called when `backendSupportsDualKey: true`. Decisions marked with
 * `IS_DEFAULT_DENY` are fall-throughs (no matching rule) and are skipped
 * so that the absence of a Write/Read/Network rule does not downgrade an
 * existing `allow` decision.
 */
async function evaluateSemanticRules(
  semantics: CommandSemantics,
  resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>,
  baseQuery: PermissionQuery,
): Promise<PermissionDecision> {
  // let allows mutation to accumulate strictest result across checks
  let result: PermissionDecision = { effect: "allow" };

  for (const path of semantics.writes) {
    const d = await resolveQuery({ ...baseQuery, resource: path, action: "write" });
    if (isDefaultDenyLike(d)) continue; // fall-through, no explicit Write rule
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  for (const path of semantics.reads) {
    const d = await resolveQuery({ ...baseQuery, resource: path, action: "read" });
    if (isDefaultDenyLike(d)) continue; // fall-through, no explicit Read rule
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  for (const net of semantics.network) {
    // Query by hostname first so `Network("example.com")` blocks all ports.
    // net.host may include port (URL.host) — strip it for the host-wide check.
    const hostname = extractHostname(net.host);
    const dByHostname = await resolveQuery({ ...baseQuery, resource: hostname, action: "network" });
    if (!isDefaultDenyLike(dByHostname)) {
      result = stricter(result, dByHostname);
      if (result.effect === "deny") return result;
    }

    // Also query host:port when port is present, for port-specific rules like
    // `Network("example.com:8443")`. Skip if host and hostname are the same
    // (no port in net.host) to avoid a duplicate backend call.
    if (net.host !== hostname) {
      const dByHost = await resolveQuery({ ...baseQuery, resource: net.host, action: "network" });
      if (!isDefaultDenyLike(dByHost)) {
        result = stricter(result, dByHost);
        if (result.effect === "deny") return result;
      }
    }
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
 * `Run(...)` rule also allows the full command string (canary-suffix
 * detection).
 *
 * For `complete`/`partial` specs with semantics: evaluates `Write(path)`,
 * `Read(path)`, and `Network(host)` rules. Only enforced when
 * `backendSupportsDualKey: true` — requires a backend that marks
 * fall-through denies so unmatched resources don't downgrade allowed commands.
 *
 * For `too-complex`/`parse-unavailable` AST results: if the current
 * decision is `allow`, downgrades to `ask` (fail-closed: semantic analysis
 * is unavailable so human review is required). Non-allow decisions pass
 * through unchanged.
 */
export async function evaluateSpecGuard(opts: {
  readonly toolId: string;
  readonly rawCommand: string;
  readonly currentDecision: PermissionDecision;
  readonly resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>;
  readonly baseQuery: PermissionQuery;
  readonly registry: ReadonlyMap<string, CommandSpec>;
  /** When true, semantic Write/Read/Network rules are evaluated in addition to the exact-argv guard. */
  readonly backendSupportsDualKey?: boolean;
}): Promise<SpecGuardOutcome> {
  const {
    toolId,
    rawCommand,
    currentDecision,
    resolveQuery,
    baseQuery,
    registry,
    backendSupportsDualKey,
  } = opts;

  // Ensure the parser is ready. initializeBashAst() is idempotent — subsequent
  // calls return the cached promise and complete in O(1) once warm. Awaiting
  // here guarantees no parse-unavailable(not-initialized) denies from a
  // startup race between middleware construction and the first bash request.
  // Wrap in try/catch: WASM/I/O failures must produce a controlled hard deny,
  // not an unhandled exception that escapes wrapToolCall's middleware path.
  try {
    await initializeBashAst();
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      kind: "spec-evaluated",
      decision: { effect: "deny", reason: `bash-ast init failed: ${reason}` },
      specKind: "refused",
    };
  }

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
    // too-complex: semantic analysis is unavailable.
    // If the current decision is allow, ratchet to ask so the operator
    // confirms the command — complex shell forms can hide side effects.
    if (currentDecision.effect === "allow") {
      return {
        kind: "spec-evaluated",
        decision: {
          effect: "ask",
          reason: "complex shell form: semantic analysis unavailable, requires review",
        },
        specKind: "refused",
      };
    }
    return { kind: "skipped", reason: analysis.kind };
  }

  // Multi-command inputs (list commands, here-strings resolved as multiple
  // SimpleCommands) cannot be safely analyzed per-spec — piped/sequential
  // semantics span commands. Treat same as too-complex above.
  if (analysis.commands.length > 1) {
    if (currentDecision.effect === "allow") {
      return {
        kind: "spec-evaluated",
        decision: {
          effect: "ask",
          reason: "multi-command: semantic analysis unavailable, requires review",
        },
        specKind: "refused",
      };
    }
    return { kind: "skipped", reason: "multi-command" };
  }

  const cmd = analysis.commands[0];
  if (cmd === undefined) {
    return { kind: "skipped", reason: "empty-command-list" };
  }

  // Do NOT pass verifiedBaseName for path-qualified argv[0] (e.g. /bin/rm).
  // evaluateBashCommand requires consumer-side executable-identity verification
  // before accepting a verifiedBaseName — basename alone is insufficient because
  // /tmp/rm or ./curl could impersonate /bin/rm. Path-qualified commands fall
  // through to the refused spec path, which triggers the exact-argv guard and
  // keeps them in the ask/deny trust tier until an explicit exact rule exists.
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

    if (specResult.kind === "partial" && backendSupportsDualKey) {
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

  // complete — evaluate semantic rules only when backend can distinguish
  // matched rules from fall-through denies
  if (backendSupportsDualKey) {
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

  return { kind: "spec-evaluated", decision: currentDecision, specKind: "complete" };
}
