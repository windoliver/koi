/**
 * Sandbox policy middleware — defense-in-depth timeout, output truncation,
 * error classification, and observability for sandboxed tool execution.
 */

import type { ToolPolicy } from "@koi/core/ecs";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core/ecs";
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
import { DEFAULT_OUTPUT_LIMIT_BYTES, DEFAULT_TIMEOUT_GRACE_MS } from "./config.js";

/** Default timeout when profile does not specify one (30 s). */
const FALLBACK_TIMEOUT_MS = 30_000;

/** Module-scoped encoder — avoid allocation per wrapToolCall invocation. */
const encoder = new TextEncoder();

export function createSandboxMiddleware(config: SandboxMiddlewareConfig): KoiMiddleware {
  const {
    profileFor,
    policyFor,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
    timeoutGraceMs = DEFAULT_TIMEOUT_GRACE_MS,
    perToolOverrides,
    failClosedOnLookupError = true,
    onSandboxError,
    onSandboxMetrics,
  } = config;

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
      // 1. Resolve policy
      const resolvedPolicy = policyFor(request.toolId);
      if (resolvedPolicy === undefined && failClosedOnLookupError) {
        console.warn(
          `[middleware-sandbox] Unknown tool '${request.toolId}' — applying DEFAULT_SANDBOXED_POLICY (failClosedOnLookupError=true)`,
        );
      }
      const policy: ToolPolicy | undefined =
        resolvedPolicy ?? (failClosedOnLookupError ? DEFAULT_SANDBOXED_POLICY : undefined);

      // Unknown tool + fail-open → pass through
      if (policy === undefined) {
        return next(request);
      }

      // 2. Fast path for unsandboxed tools
      if (!policy.sandbox) {
        return next(request);
      }

      // 3. Resolve effective timeout
      const profile = profileFor(policy);
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

        onSandboxMetrics?.(request.toolId, policy, durationMs, bytes, truncated);

        if (truncated) {
          return {
            output: {
              truncated: true,
              originalBytes: bytes,
              limitBytes: outputLimitBytes,
              message: `Output truncated from ${String(bytes)} to ${String(outputLimitBytes)} bytes`,
            },
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

        if (timeoutSignal.aborted) {
          const message = `Tool "${request.toolId}" exceeded sandbox timeout (${String(totalTimeoutMs)}ms)`;
          onSandboxError?.(request.toolId, policy, "TIMEOUT", message);
          throw KoiRuntimeError.from("TIMEOUT", message, {
            cause: error,
            context: {
              toolId: request.toolId,
              sandbox: policy.sandbox,
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
