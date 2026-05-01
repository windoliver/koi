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

/** Default secret patterns to sanitize from error messages. */
const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
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
function sanitizeJsonValue(value: unknown, patterns: readonly RegExp[]): unknown {
  return sanitizeJsonValueInner(value, patterns, new WeakSet<object>());
}

function sanitizeJsonValueInner(
  value: unknown,
  patterns: readonly RegExp[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeSecrets(value, patterns);
  if (Array.isArray(value)) {
    if (seen.has(value)) return CYCLE_MARKER;
    seen.add(value);
    return value.map((v) => sanitizeJsonValueInner(v, patterns, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return CYCLE_MARKER;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeJsonValueInner(v, patterns, seen);
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
function isPostCommitFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
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
  const secretPatterns: readonly RegExp[] = config?.replaceDefaultSecretPatterns
    ? (config.secretPatterns ?? [])
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
        const errorMeta: JsonObject = {
          error: true,
          toolId: request.toolId,
          ...buildStructuredFailure(e, secretPatterns),
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
