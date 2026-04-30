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

function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  const cutoff = maxLength - TRUNCATION_SUFFIX.length;
  return `${message.slice(0, Math.max(0, cutoff))}${TRUNCATION_SUFFIX}`;
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
        const customMessage = await tryCustomFormatter(e, request.toolId, request.input);
        const rawMessage = customMessage ?? defaultFormat(e, request.toolId);
        const message = postProcess(rawMessage);
        const errorMeta: JsonObject = isKoiError(e)
          ? { error: true, toolId: request.toolId, code: e.code, retryable: e.retryable }
          : { error: true, toolId: request.toolId };

        return {
          output: message,
          metadata: errorMeta,
        };
      }
    },
  };

  return { middleware };
}
