/**
 * ace_reflect tool — LLM-triggered mid-session reflection.
 *
 * Non-blocking: returns immediately ("reflection queued"), runs reflection
 * async using the delta watermark pattern. Updated playbooks are picked up
 * by the next wrapModelCall via cache invalidation.
 *
 * Includes throttle: in-flight check + cooldown (30s or 10 steps).
 */

import type { StructuredPlaybookStore } from "@koi/ace-types";
import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { AceMiddlewareHandle } from "../ace.js";
import type { AtifWriteBehindBuffer } from "../atif-buffer.js";
import type { ConsolidationPipeline } from "../pipeline.js";
import type { TrajectoryBuffer } from "../trajectory-buffer.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AceReflectToolConfig {
  /** ATIF write-behind buffer — flushed before reflection reads. */
  readonly atifBuffer: AtifWriteBehindBuffer;
  /** The LLM pipeline for reflection + curation. */
  readonly llmPipeline: ConsolidationPipeline;
  /** Structured playbook store for watermark tracking. */
  readonly structuredPlaybookStore: StructuredPlaybookStore;
  /** ATIF document store for delta reads. */
  readonly atifStore: TrajectoryDocumentStore;
  /** Middleware handle for cache invalidation. */
  readonly aceHandle: AceMiddlewareHandle;
  /** Trajectory buffer for compact entries. */
  readonly trajectoryBuffer: TrajectoryBuffer;
  /** Document ID for the current conversation's ATIF document. */
  readonly conversationId: string;
  /** Minimum seconds between reflections. Default: 30. */
  readonly cooldownMs?: number;
  /** Minimum steps between reflections. Default: 10. */
  readonly cooldownSteps?: number;
  /** Clock function for testability. */
  readonly clock?: () => number;
  /** Callback for reflection errors. */
  readonly onReflectionError?: (error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_COOLDOWN_STEPS = 10;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the ace_reflect tool for LLM-triggered mid-session reflection. */
export function createAceReflectTool(config: AceReflectToolConfig): Tool {
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const cooldownSteps = config.cooldownSteps ?? DEFAULT_COOLDOWN_STEPS;
  const clock = config.clock ?? Date.now;
  const onError = config.onReflectionError ?? defaultReflectionErrorHandler;

  // let: mutable state for throttle tracking
  let reflectionInFlight = false;
  let lastReflectedAt = 0;
  let stepsSinceLastReflection = 0;

  const descriptor = {
    name: "ace_reflect",
    description:
      "Trigger mid-session reflection on recent actions. Non-blocking — returns immediately. " +
      "Use when you notice repeated failures or want to solidify a successful pattern.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string" as const,
          description:
            "Brief reason for triggering reflection (e.g., 'repeated file permission errors').",
        },
      },
    },
    tags: ["ace", "reflection"],
  };

  const policy: ToolPolicy = DEFAULT_UNSANDBOXED_POLICY;

  async function execute(args: JsonObject): Promise<{ readonly content: string }> {
    const now = clock();

    // Check 1: in-flight
    if (reflectionInFlight) {
      return {
        content: JSON.stringify({
          status: "skipped",
          reason: "reflection already in progress",
        }),
      };
    }

    // Check 2: cooldown (both time AND steps must be satisfied)
    // Skip cooldown on the very first reflection (lastReflectedAt === 0)
    const timeSinceLastMs = now - lastReflectedAt;
    if (
      lastReflectedAt > 0 &&
      timeSinceLastMs < cooldownMs &&
      stepsSinceLastReflection < cooldownSteps
    ) {
      const remainingMs = cooldownMs - timeSinceLastMs;
      const remainingSteps = cooldownSteps - stepsSinceLastReflection;
      return {
        content: JSON.stringify({
          status: "skipped",
          reason: "cooldown active",
          cooldownRemainingMs: remainingMs,
          cooldownRemainingSteps: remainingSteps,
        }),
      };
    }

    // Accept the reflection request
    reflectionInFlight = true;

    const reason = typeof args.reason === "string" ? args.reason : undefined;

    // Fire-and-forget: flush buffer, run reflection, invalidate cache
    void runReflection(reason, now)
      .catch((e: unknown) => {
        onError(e);
      })
      .finally(() => {
        reflectionInFlight = false;
      });

    return {
      content: JSON.stringify({
        status: "queued",
        ...(reason !== undefined ? { reason } : {}),
      }),
    };
  }

  async function runReflection(_reason: string | undefined, startedAt: number): Promise<void> {
    // Flush buffer so all recent steps are persisted
    await config.atifBuffer.flush(config.conversationId);

    // Get compact trajectory entries for the pipeline
    const entries = config.trajectoryBuffer.flush();

    // Run the LLM pipeline (reflector → curator → apply with watermark)
    await config.llmPipeline.consolidate(
      entries,
      config.conversationId,
      1, // sessionCount not meaningful for mid-session reflection
      clock,
      config.trajectoryBuffer,
    );

    // Invalidate middleware's playbook cache so the next model call picks up updates
    config.aceHandle.invalidatePlaybookCache();

    // Update throttle state
    lastReflectedAt = startedAt;
    stepsSinceLastReflection = 0;
  }

  const tool: Tool = {
    descriptor,
    origin: "@koi/middleware-ace",
    policy,
    execute,
  };

  return tool;
}

/** Increment the step counter (called from outside after each tool/model call). */
export function incrementReflectStepCounter(tool: Tool): void {
  // Access the closure state via a side channel — not ideal but keeps
  // the tool interface clean. The step counter is incremented externally.
  const internal = tool as { _stepsSinceLastReflection?: number };
  if (internal._stepsSinceLastReflection !== undefined) {
    internal._stepsSinceLastReflection++;
  }
}

function defaultReflectionErrorHandler(error: unknown): void {
  console.warn("ACE: ace_reflect failed", error);
}
