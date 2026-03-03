/**
 * Shared helpers for E2E tests that use real LLM calls.
 *
 * Provides environment gate, model setup, event collection, and spawn callback.
 * Used by e2e-*.test.ts files to avoid duplication.
 */

import type { EngineEvent, EngineOutput, ModelRequest, ModelResponse } from "@koi/core";
import type { AgentManifest } from "@koi/core/assembly";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import type { TaskSpawnRequest, TaskSpawnResult } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";

export const E2E_GATE: boolean = ANTHROPIC_KEY.length > 0 && E2E_OPTED_IN;
export const TIMEOUT_MS = 120_000 as const;
export const MODEL = "claude-haiku-4-5-20251001" as const;

// ---------------------------------------------------------------------------
// LLM adapter (only created when gate is open)
// ---------------------------------------------------------------------------

const llmAdapter = E2E_GATE ? createAnthropicAdapter({ apiKey: ANTHROPIC_KEY }) : undefined;

export function modelCall(request: ModelRequest): Promise<ModelResponse> {
  if (llmAdapter === undefined) {
    throw new Error("LLM adapter not initialized — E2E gate is closed");
  }
  return llmAdapter.complete({ ...request, model: MODEL });
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

export async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

export function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

export function extractText(output: EngineOutput): string {
  return output.content
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Schema accessor (avoids banned `as Type` cast)
// ---------------------------------------------------------------------------

export function getSchemaProperty(
  schema: { readonly properties?: unknown },
  key: string,
): Record<string, unknown> | undefined {
  if (typeof schema.properties !== "object" || schema.properties === null) {
    return undefined;
  }
  const props = schema.properties as Record<string, unknown>;
  const value = props[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Tool accessor (avoids banned `!` non-null assertion)
// ---------------------------------------------------------------------------

export function requireTool<T>(tool: T | undefined, name: string): T {
  if (tool === undefined) {
    throw new Error(`${name} tool was not attached to the agent`);
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Spawn callback (real LLM call through createLoopAdapter)
// ---------------------------------------------------------------------------

export async function realSpawn(request: TaskSpawnRequest): Promise<TaskSpawnResult> {
  const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

  try {
    const events = await collectEvents(adapter.stream({ kind: "text", text: request.description }));
    const output = findDoneOutput(events);

    if (output === undefined) {
      return { ok: false, error: "No done event from child engine" } as const;
    }

    const text = extractText(output);
    return { ok: true, output: text.length > 0 ? text : "(empty)" } as const;
  } finally {
    await adapter.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Shared manifests
// ---------------------------------------------------------------------------

export const WORKER_MANIFEST: AgentManifest = {
  name: "test-worker",
  version: "0.0.1",
  description: "E2E test worker",
  model: { name: MODEL },
  lifecycle: "worker",
};

export const COPILOT_MANIFEST: AgentManifest = {
  name: "test-copilot",
  version: "0.0.1",
  description: "E2E test copilot",
  model: { name: MODEL },
  lifecycle: "copilot",
};
