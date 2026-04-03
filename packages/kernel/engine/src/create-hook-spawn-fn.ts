/**
 * createHookSpawnFn — adapter from L0 SpawnFn to L1 spawnChildAgent.
 *
 * Maps SpawnRequest fields to SpawnChildOptions for hook-agent spawns.
 * The returned SpawnFn is passed to `createHookMiddleware({ spawnFn })`.
 *
 * This adapter handles the full lifecycle:
 * 1. Build SpawnChildOptions from SpawnRequest
 * 2. Spawn via spawnChildAgent
 * 3. Run the child agent to completion
 * 4. Collect output and return SpawnResult
 */

import type {
  AgentManifest,
  CapabilityFragment,
  EngineAdapter,
  EngineEvent,
  KoiErrorCode,
  KoiMiddleware,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
} from "@koi/core";
import { spawnChildAgent } from "./spawn-child.js";
import type { SpawnChildOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Minimal interface for hook-agent session marking.
 * Matches the relevant subset of HookRegistry from @koi/hooks.
 * Defined here to avoid L1→L2 import.
 */
export interface HookAgentMarker {
  readonly markHookAgent: (sessionId: string) => void;
  readonly unmarkHookAgent: (sessionId: string) => void;
}

/** Options for creating a hook-agent SpawnFn. */
export interface CreateHookSpawnFnOptions {
  /**
   * Base options shared across all hook-agent spawns.
   * Must include parentAgent, spawnLedger, spawnPolicy, adapter.
   */
  readonly base: Omit<
    SpawnChildOptions,
    | "manifest"
    | "toolDenylist"
    | "toolAllowlist"
    | "additionalTools"
    | "nonInteractive"
    | "requiredOutputTool"
    | "limits"
    | "providers"
    | "middleware"
  >;
  /** Engine adapter factory or shared adapter for hook agents. */
  readonly adapter: EngineAdapter;
  /** Base manifest template for hook agents. Overridden per-request. */
  readonly manifestTemplate: AgentManifest;
  /**
   * Parent middleware to inherit into hook agents. Typically includes
   * observe-phase middleware (tracing, telemetry, audit) that should
   * see hook agent activity. Intercept/resolve-phase middleware (hooks,
   * permissions) should NOT be included — hook agents are isolated.
   */
  readonly inheritedMiddleware?: readonly KoiMiddleware[] | undefined;
  /**
   * Hook registry marker for recursion prevention. When provided,
   * the child session is marked as a hook agent before running and
   * unmarked after completion. This suppresses hook dispatch for the
   * child session at the registry level.
   */
  readonly hookAgentMarker?: HookAgentMarker | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SpawnFn that spawns hook-agent sub-agents via spawnChildAgent.
 *
 * Maps SpawnRequest sub-agent constraint fields to SpawnChildOptions:
 * - `toolDenylist` / `toolAllowlist` → filters inherited tools
 * - `additionalTools` → injected via component provider
 * - `maxTurns` → mapped to `limits.maxTurns`
 * - `maxTokens` → mapped to `limits.maxTokens`
 * - `nonInteractive` → passed through (approval handler stripping is caller's responsibility)
 */
export function createHookSpawnFn(options: CreateHookSpawnFnOptions): SpawnFn {
  const { base, adapter, manifestTemplate, inheritedMiddleware, hookAgentMarker } = options;

  return async (request: SpawnRequest): Promise<SpawnResult> => {
    try {
      // Build manifest for this hook agent
      const manifest: AgentManifest = {
        ...manifestTemplate,
        name: request.agentName,
        description: request.description,
      };

      // Use explicit required output tool name from the request.
      // Falls back to additionalTools[0] for backward compat, but callers
      // should always set requiredOutputToolName explicitly.
      const requiredOutputTool =
        request.requiredOutputToolName ??
        (request.outputSchema !== undefined && request.additionalTools !== undefined
          ? request.additionalTools[0]?.name
          : undefined);

      // Build middleware list: inherited (tracing) + system prompt injection
      const childMiddleware: KoiMiddleware[] = [...(inheritedMiddleware ?? [])];
      if (request.systemPrompt !== undefined) {
        childMiddleware.push(createSystemPromptMiddleware(request.systemPrompt));
      }

      // Map SpawnRequest constraint fields to SpawnChildOptions
      const spawnOptions: SpawnChildOptions = {
        ...base,
        manifest,
        adapter,
        ...(request.toolDenylist !== undefined ? { toolDenylist: request.toolDenylist } : {}),
        ...(request.toolAllowlist !== undefined ? { toolAllowlist: request.toolAllowlist } : {}),
        ...(request.additionalTools !== undefined
          ? { additionalTools: request.additionalTools }
          : {}),
        ...(request.nonInteractive !== undefined ? { nonInteractive: request.nonInteractive } : {}),
        ...(requiredOutputTool !== undefined ? { requiredOutputTool } : {}),
        ...(childMiddleware.length > 0 ? { middleware: childMiddleware } : {}),
        limits: {
          ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        },
      };

      const { runtime, handle } = await spawnChildAgent(spawnOptions);
      const childSessionId = runtime.sessionId;

      // Mark child as hook agent for recursion suppression at the registry level
      hookAgentMarker?.markHookAgent(childSessionId);

      // Run the child agent to completion.
      // Identity: manifest.name = "hook-agent:<hookName>" — tracing middleware
      // reads this from the agent entity to distinguish hook agents from regular agents.
      // let justified: mutable — captures execution result before teardown
      let executionResult: SpawnResult | undefined;
      try {
        const collector = createVerdictCollector(requiredOutputTool);
        const input = {
          kind: "text" as const,
          text: request.description,
          signal: request.signal,
        };
        for await (const event of runtime.run(input)) {
          collector.observe(event);
        }

        executionResult = { ok: true, output: collector.output() };
      } finally {
        hookAgentMarker?.unmarkHookAgent(childSessionId);
        // Best-effort teardown: terminate + dispose. Errors are logged but
        // cannot override a successful verdict already captured above.
        try {
          handle.terminate();
          // Bound teardown wait to prevent indefinite hangs if terminate fails
          await Promise.race([
            handle.waitForCompletion(),
            new Promise<void>((resolve) => {
              setTimeout(resolve, 5_000);
            }),
          ]);
          await runtime.dispose();
        } catch (teardownErr: unknown) {
          console.error(`[hook-spawn] teardown error for "${request.agentName}"`, teardownErr);
        }
      }
      // Return the captured result. If execution itself threw (executionResult
      // still undefined), the outer catch handles it.
      if (executionResult !== undefined) {
        return executionResult;
      }
      // Unreachable in normal flow — execution throw propagates via finally
      throw new Error("Hook agent execution completed without result");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // Classify retryable: KoiError carries its own flag, abort/timeout
      // errors are transient by nature, everything else is non-retryable.
      const isRetryable = isKoiErrorLike(e) ? e.retryable : isAbortOrTimeoutError(e);
      return {
        ok: false,
        error: {
          code: isKoiErrorLike(e) ? e.code : "INTERNAL",
          message: `Hook agent spawn failed: ${message}`,
          retryable: isRetryable,
        },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a middleware that injects a system prompt into every model call.
 * Prepends the hook prompt to any existing systemPrompt (e.g., from the
 * structured output guard's re-prompt hint) rather than replacing it.
 */
function createSystemPromptMiddleware(hookPrompt: string): KoiMiddleware {
  return {
    name: "hook-agent:system-prompt",
    phase: "resolve",
    priority: 100,
    async wrapModelCall(_ctx, request, next) {
      return next({
        ...request,
        systemPrompt: mergeSystemPrompt(hookPrompt, request.systemPrompt),
      });
    },
    async *wrapModelStream(_ctx, request, next) {
      yield* next({
        ...request,
        systemPrompt: mergeSystemPrompt(hookPrompt, request.systemPrompt),
      });
    },
    describeCapabilities(): CapabilityFragment | undefined {
      return undefined;
    },
  };
}

/** Prepend hook prompt to existing systemPrompt, preserving guard hints. */
function mergeSystemPrompt(hookPrompt: string, existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) return hookPrompt;
  // Hook prompt first, then any guard-appended instructions
  return `${hookPrompt}\n\n${existing}`;
}

/**
 * Stateful verdict collector — captures the specific required tool's output
 * and ignores subsequent tool calls/text once the verdict is recorded.
 *
 * If no required tool is specified, falls back to collecting the last
 * tool_call_end result (backward compat).
 */
function createVerdictCollector(requiredToolName: string | undefined): {
  observe: (event: EngineEvent) => void;
  output: () => string;
} {
  let verdictCaptured = false;
  let verdictOutput = "";
  let textBuffer = "";
  /** Track the tool name for the current in-flight tool call. */
  let currentToolCallName: string | undefined;

  return {
    observe(event: EngineEvent): void {
      // Once we have the verdict, ignore everything else
      if (verdictCaptured) return;

      if (event.kind === "tool_call_start") {
        currentToolCallName = event.toolName;
        return;
      }

      if (event.kind === "tool_call_end") {
        const isVerdictTool =
          requiredToolName !== undefined && currentToolCallName === requiredToolName;
        currentToolCallName = undefined;

        if (isVerdictTool) {
          // Capture the verdict and stop — ignore subsequent events
          verdictCaptured = true;
          const result = event.result;
          if (typeof result === "string") {
            verdictOutput = result;
          } else if (typeof result === "object" && result !== null) {
            verdictOutput = JSON.stringify(result);
          }
          return;
        }

        // No required tool specified — fall back to last tool result
        if (requiredToolName === undefined) {
          const result = event.result;
          if (typeof result === "string") {
            verdictOutput = result;
          } else if (typeof result === "object" && result !== null) {
            verdictOutput = JSON.stringify(result);
          }
        }
        return;
      }

      if (event.kind === "text_delta") {
        textBuffer += event.delta;
      }
    },

    output(): string {
      // Verdict from the required tool takes priority; fall back to text
      return verdictOutput.length > 0 ? verdictOutput : textBuffer;
    },
  };
}

/** Detect abort/timeout errors that are transient by nature. */
function isAbortOrTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // DOMException with name "AbortError" or "TimeoutError" (from AbortSignal.timeout)
  return e.name === "AbortError" || e.name === "TimeoutError";
}

/** Type guard for objects that carry KoiError-like code + retryable fields. */
function isKoiErrorLike(
  e: unknown,
): e is { readonly code: KoiErrorCode; readonly retryable: boolean } {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as Record<string, unknown>).code === "string" &&
    "retryable" in e &&
    typeof (e as Record<string, unknown>).retryable === "boolean"
  );
}
