/**
 * Sandbox policy middleware — defense-in-depth timeout, output truncation,
 * error classification, and observability for sandboxed tool execution.
 */

import type { TrustTier } from "@koi/core/ecs";
import type {
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { SandboxMiddlewareConfig } from "./config.js";
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  DEFAULT_SKIP_TIERS,
  DEFAULT_TIMEOUT_GRACE_MS,
} from "./config.js";

/** Default timeout when profile does not specify one (30 s). */
const FALLBACK_TIMEOUT_MS = 30_000;

const TRUNCATION_MARKER = "...[truncated]";

export function createSandboxMiddleware(config: SandboxMiddlewareConfig): KoiMiddleware {
  const {
    profileFor,
    tierFor,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
    timeoutGraceMs = DEFAULT_TIMEOUT_GRACE_MS,
    skipTiers = DEFAULT_SKIP_TIERS,
    perToolOverrides,
    failClosedOnLookupError = true,
    onSandboxError,
    onSandboxMetrics,
  } = config;

  const skipSet = new Set(skipTiers);

  return {
    name: "sandbox",
    priority: 200,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // 1. Resolve trust tier
      const resolvedTier = tierFor(request.toolId);
      const tier: TrustTier | undefined =
        resolvedTier ?? (failClosedOnLookupError ? "sandbox" : undefined);

      // Unknown tool + fail-open → pass through
      if (tier === undefined) {
        return next(request);
      }

      // 2. Fast path for skip tiers (promoted by default)
      if (skipSet.has(tier)) {
        return next(request);
      }

      // 3. Resolve effective timeout
      const profile = profileFor(tier);
      const overrides = perToolOverrides?.get(request.toolId);
      const effectiveTimeoutMs =
        overrides?.timeoutMs ?? profile.resources.timeoutMs ?? FALLBACK_TIMEOUT_MS;
      const totalTimeoutMs = effectiveTimeoutMs + timeoutGraceMs;

      // 4. Execute with timeout wrapping
      // let justified: mutable flag tracking async timeout state
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const start = performance.now();

      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`middleware-sandbox-timeout:${request.toolId}`));
          }, totalTimeoutMs);
        });

        const response = await Promise.race([next(request), timeoutPromise]);

        const durationMs = Math.round(performance.now() - start);

        // 5. Output truncation (byte-accurate)
        const encoder = new TextEncoder();
        const encoded = encoder.encode(JSON.stringify(response.output));
        const bytes = encoded.byteLength;
        const truncated = bytes > outputLimitBytes;

        onSandboxMetrics?.(request.toolId, tier, durationMs, bytes, truncated);

        if (truncated) {
          const decoder = new TextDecoder("utf-8", { fatal: false });
          const truncatedJson =
            decoder.decode(encoded.slice(0, outputLimitBytes)) + TRUNCATION_MARKER;
          return {
            output: truncatedJson,
            metadata: {
              ...response.metadata,
              truncated: true,
              originalBytes: bytes,
            },
          };
        }

        return response;
      } catch (error: unknown) {
        const durationMs = Math.round(performance.now() - start);

        if (timedOut) {
          const message = `Tool "${request.toolId}" exceeded sandbox timeout (${String(totalTimeoutMs)}ms)`;
          onSandboxError?.(request.toolId, tier, "TIMEOUT", message);
          throw KoiRuntimeError.from("TIMEOUT", message, {
            cause: error,
            context: {
              toolId: request.toolId,
              tier,
              durationMs,
              timeoutMs: totalTimeoutMs,
            },
          });
        }

        // Not our timeout — re-throw unchanged
        throw error;
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    },
  };
}
