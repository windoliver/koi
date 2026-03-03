/**
 * Sandbox policy middleware — defense-in-depth timeout, output truncation,
 * error classification, and observability for sandboxed tool execution.
 */

import type { TrustTier } from "@koi/core/ecs";
import type {
  CapabilityFragment,
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

/** Module-scoped encoder/decoder — avoid allocation per wrapToolCall invocation. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

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

  const capabilityFragment: CapabilityFragment = {
    label: "sandbox",
    description:
      `Tool sandboxing: timeout + ${String(timeoutGraceMs)}ms grace, output limit ${String(outputLimitBytes)} bytes` +
      (failClosedOnLookupError ? ", fail-closed on unknown tools" : ""),
  };

  return {
    name: "sandbox",
    priority: 200,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

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

      // 4. Execute with signal-based timeout + backstop race
      const timeoutSignal = AbortSignal.timeout(totalTimeoutMs);

      // Compose sandbox timeout signal with upstream request.signal (if present)
      const effectiveSignal =
        request.signal !== undefined
          ? AbortSignal.any([request.signal, timeoutSignal])
          : timeoutSignal;

      // Fast-path: throw immediately if composed signal is already aborted
      // (matches the three-layer defense pattern in executeWithSignal)
      effectiveSignal.throwIfAborted();

      // Thread composed signal to downstream middleware/tool
      const signalledRequest: ToolRequest = { ...request, signal: effectiveSignal };

      const start = performance.now();

      // let justified: assigned inside backstop promise, cleaned up in finally
      let onAbort: (() => void) | undefined;

      try {
        const backstopPromise = new Promise<never>((_resolve, reject) => {
          if (timeoutSignal.aborted) {
            reject(timeoutSignal.reason);
            return;
          }
          onAbort = () => reject(timeoutSignal.reason);
          timeoutSignal.addEventListener("abort", onAbort, { once: true });
        });

        const response = await Promise.race([next(signalledRequest), backstopPromise]);

        const durationMs = Math.round(performance.now() - start);

        // 5. Output truncation (byte-accurate)
        const encoded = encoder.encode(JSON.stringify(response.output));
        const bytes = encoded.byteLength;
        const truncated = bytes > outputLimitBytes;

        onSandboxMetrics?.(request.toolId, tier, durationMs, bytes, truncated);

        if (truncated) {
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

        // Discriminate our timeout from other errors. We check timeoutSignal
        // specifically (not effectiveSignal) to distinguish sandbox timeout from
        // upstream cancellation. There is a negligible TOCTOU window where the
        // signal could abort between the throw and this check, but the worst case
        // is mis-classifying an upstream abort as a timeout — acceptable for
        // observability purposes.
        if (timeoutSignal.aborted) {
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
        if (onAbort !== undefined) {
          timeoutSignal.removeEventListener("abort", onAbort);
        }
      }
    },
  };
}
