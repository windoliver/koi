/**
 * Tool error formatter middleware factory — catches tool errors via
 * `wrapToolCall`, formats them into actionable messages, and returns
 * them as ToolResponse instead of throwing.
 *
 * Priority 170: outer layer, runs after inner middleware (e.g.
 * semantic-retry at 420) has exhausted retries.
 */

import type {
  CapabilityFragment,
  JsonObject,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { formatToolError, isKoiError, toKoiError } from "@koi/errors";
import type { ToolErrorFormatterConfig } from "./types.js";

/**
 * Default secret patterns to sanitize from error messages, stacks, and
 * structured context before they reach the model or logs. Covers common
 * credential shapes seen in tool error payloads: API keys, HTTP auth
 * headers, cookies, signed-URL query parameters, JWTs, AWS access keys,
 * GitHub PATs, Slack tokens, and password-bearing connection strings.
 *
 * Caller-supplied `secretPatterns` extend this list (see
 * `replaceDefaultSecretPatterns` in types.ts to opt out).
 */
const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  // Generic API key prefixes (OpenAI, Anthropic, etc.)
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // HTTP auth headers
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
  // Cookie/Set-Cookie values
  /\b(?:Cookie|Set-Cookie):\s*[^\r\n]+/gi,
  // Signed-URL query parameters (AWS, Azure, GCP)
  /\b(?:X-Amz-Signature|X-Amz-Security-Token|sig|signature|sas|token|access_token|refresh_token|api_key|apikey|password|passwd|pwd|secret)=[^\s&"']+/gi,
  // JWT (three base64url segments)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // AWS access keys and GitHub PATs
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgho_[A-Za-z0-9]{36}\b/g,
  /\bghs_[A-Za-z0-9]{36}\b/g,
  /\bghu_[A-Za-z0-9]{36}\b/g,
  // Slack / Stripe / Google tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:rk|sk|pk)_(?:test|live)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Connection strings with embedded credentials (postgres://user:pass@...)
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s"']+/gi,
] as const;

const DEFAULT_MAX_MESSAGE_LENGTH = 1000;

/**
 * Default passthrough codes is empty by design.
 *
 * Error codes alone are not a trustworthy guardrail signal: a tool wrapping
 * a third-party SDK can legitimately surface upstream `RATE_LIMIT` or
 * `PERMISSION` errors as ordinary tool failures, and converting those into
 * hard-stop turn aborts is a behavioral regression. The PRIMARY mechanism
 * for keeping guardrail aborts hard-stop is priority ordering: guardrail
 * middleware should sit OUTSIDE this formatter (priority < 170) so its
 * throws never enter our catch block to begin with.
 *
 * Callers who place a guardrail INSIDE this formatter (e.g.,
 * `@koi/middleware-call-limits` at priority 175) MUST opt in by setting
 * `passthroughCodes` and/or `passthroughPredicate` for that specific stack.
 * Defense-in-depth, not magic defaults.
 */
const DEFAULT_PASSTHROUGH_CODES: readonly string[] = [] as const;

const TRUNCATION_SUFFIX = "... (truncated)";

const CYCLE_MARKER = "[Circular]";

/**
 * Recursively sanitize string values inside a JSON-shaped value. Used to
 * scrub secrets from `KoiError.context` and similar structured fields before
 * we hand them to downstream observers — tools sometimes embed auth tokens,
 * cookies, or request bodies in `context` and we treat that as untrusted.
 *
 * Cycle-safe via a WeakSet of in-progress containers; any back-edge resolves
 * to the string `"[Circular]"` so the formatter never recurses infinitely on
 * cyclic error payloads.
 */
/**
 * Maximum traversal depth for context sanitization. Tools may surface
 * arbitrary upstream payloads as `KoiError.context`; an extremely deep
 * nesting would overflow the call stack and turn a handled tool error
 * into a turn-level crash. Past this depth the marker `[TruncatedDepth]`
 * is substituted in place of further recursion.
 */
const MAX_SANITIZE_DEPTH = 64;

const DEPTH_TRUNCATED_MARKER = "[TruncatedDepth]";

/**
 * Object keys that imply the value is a credential/secret regardless of its
 * shape. When an object is sanitized, any value under one of these keys is
 * fully redacted to `[REDACTED]` (string, number, even truthy boolean) rather
 * than scanned with regex patterns. A short opaque API key, a password, or a
 * cookie string typically won't match any of the high-entropy regexes — but
 * the field name alone is enough to know the value is sensitive.
 *
 * Match is case-insensitive and snake_case/camelCase tolerant.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /^pwd$/i,
  /(?:^|_|-)secret(?:s)?(?:$|_|-)/i,
  /^secret(?:s)?$/i,
  /(?:^|_|-)token(?:s)?(?:$|_|-)/i,
  /^token(?:s)?$/i,
  /authorization/i,
  /^authn?$/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /(?:^|_|-)key(?:s)?(?:$|_|-)/i, // matches privateKey, signing_key, etc.
  /cookie/i,
  /session[_-]?id/i,
  /credentials?/i,
  /bearer/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
  /client[_-]?secret/i,
  /private[_-]?key/i,
];

const REDACTED_MARKER = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

function sanitizeJsonValue(value: unknown, patterns: readonly RegExp[]): unknown {
  return sanitizeJsonValueInner(value, patterns, new WeakSet<object>(), 0);
}

function sanitizeJsonValueInner(
  value: unknown,
  patterns: readonly RegExp[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth >= MAX_SANITIZE_DEPTH) return DEPTH_TRUNCATED_MARKER;
  if (typeof value === "string") return sanitizeSecrets(value, patterns);
  // JSON-safe primitives pass through unchanged.
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value) || typeof value === "boolean" ? value : null;
  }
  // Non-JSON-serializable runtime values: coerce to strings (with secret
  // sanitization) or drop. Without this, JSON.stringify on the resulting
  // metadata would throw on bigint/function/symbol downstream and turn a
  // handled tool error into a turn-level crash.
  if (typeof value === "bigint") return sanitizeSecrets(`${value.toString()}n`, patterns);
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (typeof value === "undefined") return null;
  // Date and other built-ins with sensible toJSON / toISOString.
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return CYCLE_MARKER;
    seen.add(value);
    return value.map((v) => sanitizeJsonValueInner(v, patterns, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return CYCLE_MARKER;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Key-aware redaction: if the field name implies the value is a
      // credential, fully redact regardless of its shape (a short opaque
      // password or token won't match any regex). Null/undefined still
      // come through as null.
      if (isSensitiveKey(k) && v !== null && v !== undefined) {
        out[k] = REDACTED_MARKER;
        continue;
      }
      out[k] = sanitizeJsonValueInner(v, patterns, seen, depth + 1);
    }
    return out;
  }
  return value;
}

function sanitizeSecrets(message: string, patterns: readonly RegExp[]): string {
  // Reduce over patterns; rebuild each regex to reset lastIndex for global flags.
  let result = message;
  for (const pattern of patterns) {
    const p = new RegExp(pattern.source, pattern.flags);
    result = result.replace(p, "[REDACTED]");
  }
  return result;
}

/**
 * Unforgeable provenance markers for hard-stop signals. Trusted middleware
 * imports these symbols and tags its thrown errors with them; the formatter
 * honors symbol-marked errors as authoritative. This closes the marker-
 * forgery hole where a tool could set `guardrail: true` on its own thrown
 * Error to abort the turn — symbols are unique per import and a hostile
 * tool cannot synthesize a value equal to one it didn't import.
 *
 * The boolean property markers (`guardrail: true`, `committed: true`,
 * `internal: true`) remain accepted for ergonomic interop, but trusted
 * middleware is encouraged to use the symbol form when the threat model
 * includes hostile/buggy tool code.
 */
export const GUARDRAIL_PROVENANCE: unique symbol = Symbol(
  "@koi/middleware-tool-error-formatter:guardrail",
);
export const COMMITTED_PROVENANCE: unique symbol = Symbol(
  "@koi/middleware-tool-error-formatter:committed",
);
export const INTERNAL_PROVENANCE: unique symbol = Symbol(
  "@koi/middleware-tool-error-formatter:internal",
);

function hasSymbolMarker(error: unknown, marker: symbol): boolean {
  if (error === null || typeof error !== "object") return false;
  return (error as { [k: symbol]: unknown })[marker] === true;
}

/**
 * True if the value represents a cancellation/abort signal failure.
 *
 * The turn runner short-circuits the loop on aborted signal or AbortError —
 * but only if the throw escapes the middleware chain. If we converted an
 * abort into a ToolResponse, the runner would continue with another model
 * call after the user already pressed cancel.
 */
function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const code = (error as { code?: unknown }).code;
  if (code === "ABORT_ERR" || code === "ABORTED") return true;
  return false;
}

/**
 * True if the error is flagged as occurring AFTER the tool's side effects
 * were committed (e.g., a post-processing or audit-write failure). Returning
 * a recoverable-looking ToolResponse for such errors would invite the model
 * to retry a non-idempotent tool call and duplicate writes/payments. We
 * propagate the throw so the turn runner sees an unrecoverable failure
 * instead of a retryable tool error string.
 *
 * Inner middleware/tool handlers signal this by setting `committed: true`
 * directly on the thrown Error, or `context.committed === true` on a
 * KoiError. No marker = treat as a normal pre-commit failure (current
 * behavior preserved for callers that don't opt in).
 */
/**
 * True if the error carries an explicit `guardrail: true` provenance marker
 * (either directly on the Error or in `context.guardrail` on a KoiError).
 * Guardrail middleware (permissions, governance, rate-limit, kill-switch)
 * should mark their throws so the formatter never silently downgrades a
 * deliberate hard-stop into a recoverable-looking ToolResponse — even when
 * misordered INSIDE the formatter and not explicitly listed in
 * `passthroughCodes`. Defense-in-depth, fail-closed by signal not by config.
 */
function isGuardrailError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if (hasSymbolMarker(error, GUARDRAIL_PROVENANCE)) return true;
  if ((error as { guardrail?: unknown }).guardrail === true) return true;
  const ctx = (error as { context?: unknown }).context;
  if (
    ctx !== null &&
    typeof ctx === "object" &&
    (ctx as { guardrail?: unknown }).guardrail === true
  ) {
    return true;
  }
  return false;
}

/**
 * True if the error is flagged as an INTERNAL runtime/middleware invariant
 * failure (engine-contract violation, session-admission failure, broken
 * middleware wiring). These must NOT be downgraded into a recoverable
 * `ToolResponse` — the model retrying the tool is not the right recovery
 * path; the operator/runtime must see the failure and stop or repair.
 *
 * Inner middleware signals this via `internal: true` directly on the
 * thrown Error, or `context.internal === true` on a KoiError. The
 * KoiError `code` field alone is NOT a propagation signal — `INTERNAL`
 * is also a legitimate generic error code for tool/integration faults
 * that the model should see and react to. Explicit marker required.
 */
function isInternalRuntimeError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if (hasSymbolMarker(error, INTERNAL_PROVENANCE)) return true;
  if ((error as { internal?: unknown }).internal === true) return true;
  const ctx = (error as { context?: unknown }).context;
  if (
    ctx !== null &&
    typeof ctx === "object" &&
    (ctx as { internal?: unknown }).internal === true
  ) {
    return true;
  }
  return false;
}

function isPostCommitFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if (hasSymbolMarker(error, COMMITTED_PROVENANCE)) return true;
  if ((error as { committed?: unknown }).committed === true) return true;
  const ctx = (error as { context?: unknown }).context;
  if (
    ctx !== null &&
    typeof ctx === "object" &&
    (ctx as { committed?: unknown }).committed === true
  ) {
    return true;
  }
  return false;
}

function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  const cutoff = maxLength - TRUNCATION_SUFFIX.length;
  return `${message.slice(0, Math.max(0, cutoff))}${TRUNCATION_SUFFIX}`;
}

/**
 * Build a structured failure record for downstream observers (audit, telemetry,
 * outer middleware). The model-facing `output` string is intentionally lossy
 * (sanitized + truncated); this metadata preserves the raw error fields needed
 * to diagnose the failure or drive recovery — sanitized for secrets but not
 * truncated, and JSON-serializable.
 */
function buildStructuredFailure(error: unknown, secretPatterns: readonly RegExp[]): JsonObject {
  const out: { -readonly [K in keyof JsonObject]: JsonObject[K] } = {};
  // KoiError fields (code/retryable/context/retryAfterMs) and Error fields
  // (stack, cause) are additive — KoiRuntimeError satisfies both shapes and
  // we want both diagnostic surfaces preserved.
  if (isKoiError(error)) {
    out.code = error.code;
    out.retryable = error.retryable;
    out.originalMessage = sanitizeSecrets(error.message, secretPatterns);
    if (error.context !== undefined) {
      out.context = sanitizeJsonValue(error.context, secretPatterns) as JsonObject;
    }
    if (error.retryAfterMs !== undefined) out.retryAfterMs = error.retryAfterMs;
    if (error.cause !== undefined) {
      const causeMessage = extractMessage(error.cause);
      if (causeMessage.length > 0) out.cause = sanitizeSecrets(causeMessage, secretPatterns);
    }
  } else if (error instanceof Error) {
    out.originalMessage = sanitizeSecrets(error.message, secretPatterns);
  } else {
    out.originalMessage = sanitizeSecrets(extractMessage(error), secretPatterns);
    return out;
  }
  if (error instanceof Error) {
    if (typeof error.stack === "string" && error.stack.length > 0) {
      out.stack = sanitizeSecrets(error.stack, secretPatterns);
    }
    if (out.cause === undefined && error.cause !== undefined) {
      const causeMessage = extractMessage(error.cause);
      if (causeMessage.length > 0) out.cause = sanitizeSecrets(causeMessage, secretPatterns);
    }
  }
  return out;
}

function extractMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "message" in value) {
    const m = (value as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return String(value);
  } catch {
    return "";
  }
}

export interface ToolErrorFormatterHandle {
  readonly middleware: KoiMiddleware;
}

export function createToolErrorFormatterMiddleware(
  config?: ToolErrorFormatterConfig,
): ToolErrorFormatterHandle {
  const customFormatter = config?.formatter;
  const maxMessageLength = config?.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
  // Caller-supplied patterns extend the defaults rather than replacing them —
  // a custom pattern must never silently disable redaction of `sk-…` API keys
  // or HTTP `Bearer` tokens. Use `replaceDefaultSecretPatterns: true` to opt
  // out (e.g., a test that needs predictable output).
  // Non-removable minimum redaction set: even when the caller opts to
  // replace the default patterns (e.g., for tests with predictable output),
  // these high-risk credential shapes must always be sanitized. A runtime
  // misconfiguration cannot silently turn the formatter into a secret-leak
  // surface for API keys, bearer tokens, or password-bearing connection
  // strings.
  const MINIMUM_SECRET_PATTERNS: readonly RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{20,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s"']+/gi,
  ];
  const secretPatterns: readonly RegExp[] = config?.replaceDefaultSecretPatterns
    ? [...MINIMUM_SECRET_PATTERNS, ...(config.secretPatterns ?? [])]
    : [...DEFAULT_SECRET_PATTERNS, ...(config?.secretPatterns ?? [])];
  const passthroughCodes = new Set<string>(config?.passthroughCodes ?? DEFAULT_PASSTHROUGH_CODES);
  const passthroughPredicate = config?.passthroughPredicate;

  const capabilityFragment: CapabilityFragment = {
    label: "tool-error-formatter",
    description: "Formats tool errors into actionable model feedback",
  };

  function postProcess(message: string): string {
    const sanitized = sanitizeSecrets(message, secretPatterns);
    return truncateMessage(sanitized, maxMessageLength);
  }

  function defaultFormat(error: unknown, toolId: string): string {
    return formatToolError(error, toolId);
  }

  async function tryCustomFormatter(
    error: unknown,
    toolId: string,
    input: JsonObject,
  ): Promise<string | undefined> {
    if (customFormatter === undefined) return undefined;
    try {
      const koiError = toKoiError(error);
      const result = await customFormatter(koiError, toolId, input);
      if (typeof result !== "string") return undefined;
      return result;
    } catch {
      return undefined;
    }
  }

  const middleware: KoiMiddleware = {
    name: "tool-error-formatter",
    priority: 170,

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      try {
        return await next(request);
      } catch (e: unknown) {
        // Cancellation must propagate. Converting an AbortError into a
        // ToolResponse would cause the turn runner to continue with another
        // model call after the user already canceled the turn.
        if (request.signal?.aborted === true || isAbortError(e)) {
          throw e;
        }
        // Internal runtime/middleware invariant failures must propagate.
        // The model cannot recover from a broken middleware contract; only
        // the operator/runtime can. Without this, an invariant failure
        // would surface as a recoverable-looking ToolResponse and the loop
        // would continue calling tools while the runtime is in a bad state.
        if (isInternalRuntimeError(e)) {
          throw e;
        }
        // Guardrail-flagged errors propagate regardless of priority ordering.
        // Permissions/rate-limit/governance middleware that surfaces a
        // deliberate hard-stop must set `guardrail: true` on the thrown
        // error (or `context.guardrail: true` on a KoiError). This is the
        // fail-closed default — misordering or unconfigured passthroughCodes
        // can no longer silently downgrade a guardrail abort into model
        // recovery text.
        if (isGuardrailError(e)) {
          throw e;
        }
        // Post-commit failures must propagate. The tool's side effects have
        // already happened; surfacing this as a retryable-looking
        // ToolResponse would cause the model to re-invoke a non-idempotent
        // tool and duplicate writes/payments/state changes.
        if (isPostCommitFailure(e)) {
          throw e;
        }
        // Hard-stop guardrail errors (rate-limit, permission denial, ...)
        // also propagate. Formatting them as a model-readable ToolResponse
        // would let the engine continue past a deliberate abort.
        if (isKoiError(e) && passthroughCodes.has(e.code)) {
          throw e;
        }
        if (passthroughPredicate !== undefined) {
          let shouldPassthrough = false;
          try {
            shouldPassthrough = passthroughPredicate(e);
          } catch {
            shouldPassthrough = false;
          }
          if (shouldPassthrough) throw e;
        }
        const customMessage = await tryCustomFormatter(e, request.toolId, request.input);
        const rawMessage = customMessage ?? defaultFormat(e, request.toolId);
        const message = postProcess(rawMessage);
        // Structured-failure construction sanitizes potentially-arbitrary
        // payloads (KoiError.context, stack, cause). A malformed tool throw
        // could in theory cause sanitization itself to throw or stack-overflow
        // — degrade to a minimal metadata block rather than letting the
        // formatter (a safety boundary) escape its catch and abort the turn.
        let structured: JsonObject;
        try {
          structured = buildStructuredFailure(e, secretPatterns);
        } catch {
          structured = { originalMessage: "[formatter: structured-failure construction failed]" };
        }
        const errorMeta: JsonObject = {
          error: true,
          toolId: request.toolId,
          ...structured,
        };

        return {
          output: message,
          metadata: errorMeta,
        };
      }
    },
  };

  return { middleware };
}
