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

const TRUNCATION_SUFFIX = "... (truncated)";

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
  if (isKoiError(error)) {
    out.code = error.code;
    out.retryable = error.retryable;
    out.originalMessage = sanitizeSecrets(error.message, secretPatterns);
    if (error.context !== undefined) out.context = error.context;
    if (error.retryAfterMs !== undefined) out.retryAfterMs = error.retryAfterMs;
    if (error.cause !== undefined) {
      const causeMessage = extractMessage(error.cause);
      if (causeMessage.length > 0) out.cause = sanitizeSecrets(causeMessage, secretPatterns);
    }
    return out;
  }
  if (error instanceof Error) {
    out.originalMessage = sanitizeSecrets(error.message, secretPatterns);
    if (typeof error.stack === "string" && error.stack.length > 0) {
      out.stack = sanitizeSecrets(error.stack, secretPatterns);
    }
    if (error.cause !== undefined) {
      const causeMessage = extractMessage(error.cause);
      if (causeMessage.length > 0) out.cause = sanitizeSecrets(causeMessage, secretPatterns);
    }
    return out;
  }
  out.originalMessage = sanitizeSecrets(extractMessage(error), secretPatterns);
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
  const secretPatterns = config?.secretPatterns ?? DEFAULT_SECRET_PATTERNS;

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
