/**
 * E2E: feedback-loop middleware tool health tracking + quarantine.
 *
 * Validates that:
 * 1. A forged tool's success/failure is tracked through the middleware
 * 2. A tool that exceeds the error threshold gets quarantined
 * 3. Subsequent calls to a quarantined tool return ForgeToolErrorFeedback (not throw)
 * 4. Non-forged (entity) tools are unaffected by health tracking
 * 5. ForgeStore.update and SnapshotStore.record are called during quarantine
 * 6. The onQuarantine callback fires
 *
 * Run: bun scripts/e2e-tool-health.ts
 * No API key needed — uses scripted model responses.
 */

import type {
  EngineEvent,
  ForgeStore,
  JsonObject,
  ModelRequest,
  ModelResponse,
  SnapshotStore,
  Tool,
} from "../packages/core/src/index.js";
import { toolToken } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import type {
  ForgeHealthConfig,
  ForgeToolErrorFeedback,
} from "../packages/middleware-feedback-loop/src/index.js";
import { createFeedbackLoopMiddleware } from "../packages/middleware-feedback-loop/src/index.js";

// ---------------------------------------------------------------------------
// Scripted model — returns pre-programmed responses per turn
// ---------------------------------------------------------------------------

function createScriptedModel(
  script: readonly ((messages: readonly unknown[]) => ModelResponse)[],
): (request: ModelRequest) => Promise<ModelResponse> {
  // let justified: mutable turn counter
  let turn = 0;
  return async (request: ModelRequest): Promise<ModelResponse> => {
    const handler = script[turn];
    if (handler === undefined) {
      return { content: "Script exhausted", model: "scripted" };
    }
    turn++;
    return handler(request.messages);
  };
}

// ---------------------------------------------------------------------------
// In-memory mock stores that track calls
// ---------------------------------------------------------------------------

interface StoreCallLog {
  readonly forgeUpdates: Array<{ readonly id: string; readonly updates: unknown }>;
  readonly snapshotRecords: Array<{ readonly snapshot: unknown }>;
}

function createTrackingForgeStore(callLog: StoreCallLog): ForgeStore {
  return {
    save: async () => ({ ok: true as const, value: undefined }),
    load: async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    }),
    search: async () => ({ ok: true as const, value: [] }),
    remove: async () => ({ ok: true as const, value: undefined }),
    update: async (id, updates) => {
      callLog.forgeUpdates.push({ id, updates });
      return { ok: true as const, value: undefined };
    },
    exists: async () => ({ ok: true as const, value: false }),
  };
}

function createTrackingSnapshotStore(callLog: StoreCallLog): SnapshotStore {
  return {
    record: async (snapshot) => {
      callLog.snapshotRecords.push({ snapshot });
      return { ok: true as const, value: undefined };
    },
    get: async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    }),
    list: async () => ({ ok: true as const, value: [] }),
    history: async () => ({ ok: true as const, value: [] }),
    latest: async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    }),
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const log = (tag: string, msg: string): void => console.log(`  [${tag}] ${msg}`);
const pass = (msg: string): void => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg: string): void => {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
};

async function main(): Promise<void> {
  console.log("\n═══ E2E: Tool Health Tracking + Quarantine ═══\n");
  await runTest();
  console.log("\n═══ ALL CHECKS PASSED ═══\n");
}

async function runTest(): Promise<void> {
  // --- 1. Setup: stores + health config ---
  const callLog: StoreCallLog = { forgeUpdates: [], snapshotRecords: [] };
  const quarantinedBricks: string[] = [];

  const forgeStore = createTrackingForgeStore(callLog);
  const snapshotStore = createTrackingSnapshotStore(callLog);

  const forgeHealth: ForgeHealthConfig = {
    resolveBrickId: (toolId: string) =>
      toolId === "flaky-forged-tool" ? "brick-flaky" : undefined,
    forgeStore,
    snapshotStore,
    quarantineThreshold: 0.5,
    windowSize: 2,
    maxRecentFailures: 5,
    onQuarantine: (brickId: string) => {
      quarantinedBricks.push(brickId);
    },
    clock: Date.now,
  };

  // --- 2. Setup: tools ---
  // Entity tool — always succeeds
  const entityToolCalls: string[] = [];
  const entityTool: Tool = {
    descriptor: { name: "echo", description: "Echo input", inputSchema: {} },
    trustTier: "verified",
    execute: async (input: unknown): Promise<unknown> => {
      const msg = (input as Record<string, unknown>).msg ?? "?";
      entityToolCalls.push(String(msg));
      return `echoed: ${msg}`;
    },
  };

  // Forged tool — always throws (simulates a broken forged tool)
  const forgedToolCalls: number[] = [];
  // let justified: tracks call count to know when tool was called
  let forgedCallCount = 0;
  const forgedTool: Tool = {
    descriptor: {
      name: "flaky-forged-tool",
      description: "A broken forged tool",
      inputSchema: {},
    },
    trustTier: "sandbox",
    execute: async (_input: unknown): Promise<unknown> => {
      forgedCallCount++;
      forgedToolCalls.push(forgedCallCount);
      throw new Error(`Forged tool crash #${forgedCallCount}`);
    },
  };

  // --- 3. Setup: scripted model ---
  // Turn 0: call entity tool "echo"
  // Turn 1: call forged tool (will fail — recorded as failure #1)
  // Turn 2: call forged tool again (will fail — failure #2, triggers quarantine)
  // Turn 3: call forged tool again (should be quarantined — returns feedback, NOT throw)
  // Turn 4: call entity tool again (should still work fine)
  // Turn 5: final text (loop ends)
  const modelScript = createScriptedModel([
    () => ({
      content: "Let me echo first.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "echo", callId: "c0", input: { msg: "hello" } }],
      } as JsonObject,
    }),
    () => ({
      content: "Now calling the flaky tool.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "flaky-forged-tool", callId: "c1", input: { data: "test1" } }],
      } as JsonObject,
    }),
    () => ({
      content: "Trying the flaky tool again.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "flaky-forged-tool", callId: "c2", input: { data: "test2" } }],
      } as JsonObject,
    }),
    () => ({
      content: "One more try with the flaky tool.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "flaky-forged-tool", callId: "c3", input: { data: "test3" } }],
      } as JsonObject,
    }),
    () => ({
      content: "Back to the echo tool.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "echo", callId: "c4", input: { msg: "still works" } }],
      } as JsonObject,
    }),
    () => ({
      content: "All done!",
      model: "scripted",
    }),
  ]);

  // --- 4. Setup: engine ---
  const feedbackLoop = createFeedbackLoopMiddleware({ forgeHealth });
  const loopAdapter = createLoopAdapter({ modelCall: modelScript, maxTurns: 20 });

  const runtime = await createKoi({
    manifest: {
      name: "Health Tracking E2E Agent",
      version: "0.1.0",
      model: { name: "scripted" },
    },
    adapter: loopAdapter,
    middleware: [feedbackLoop],
    loopDetection: false,
    providers: [
      {
        name: "test-tools",
        attach: async () =>
          new Map<string, Tool>([
            [toolToken("echo") as string, entityTool],
            [toolToken("flaky-forged-tool") as string, forgedTool],
          ]),
      },
    ],
  });

  log("setup", `Agent assembled (state: ${runtime.agent.state})`);

  // --- 5. Run agent ---
  const events: EngineEvent[] = [];
  const toolResults: Array<{
    readonly callId: string;
    readonly result: unknown;
    readonly error?: string;
  }> = [];

  for await (const event of runtime.run({ kind: "text", text: "Start tool health E2E" })) {
    events.push(event);

    if (event.kind === "tool_call_start") {
      log("tool_call", `${event.toolName} (${event.callId})`);
    } else if (event.kind === "tool_call_end") {
      log("tool_result", `${event.callId} → ${JSON.stringify(event.result)}`);
      toolResults.push({ callId: event.callId, result: event.result });
    } else if (event.kind === "error") {
      log("error", `${event.message}`);
    } else if (event.kind === "turn_end") {
      log("turn_end", `turn ${event.turnIndex}`);
    } else if (event.kind === "done") {
      log("done", `stopReason=${event.output.stopReason} turns=${event.output.metrics.turns}`);
    }
  }

  // --- 6. Verify ---
  console.log("\n--- Verification ---\n");

  // Check 1: Entity tool "echo" was called in turn 0
  if (entityToolCalls.length < 1 || entityToolCalls[0] !== "hello") {
    fail(`Entity tool 'echo' not called with 'hello' (got: ${JSON.stringify(entityToolCalls)})`);
  }
  pass("Entity tool 'echo' executed with msg='hello'");

  // Check 2: Forged tool was actually called (before quarantine)
  if (forgedToolCalls.length < 2) {
    fail(
      `Forged tool should have been called at least 2 times before quarantine (got: ${forgedToolCalls.length})`,
    );
  }
  pass(`Forged tool was called ${forgedToolCalls.length} times before quarantine`);

  // Check 3: After quarantine, the forged tool call returns ForgeToolErrorFeedback
  const c3Result = toolResults.find((r) => r.callId === "c3");
  if (c3Result === undefined) {
    fail("Tool call c3 (post-quarantine) result not found");
  }
  const feedback = c3Result.result as ForgeToolErrorFeedback | undefined;
  if (
    feedback === undefined ||
    typeof feedback !== "object" ||
    !("error" in feedback) ||
    !("suggestion" in feedback)
  ) {
    fail(
      `Post-quarantine call should return ForgeToolErrorFeedback (got: ${JSON.stringify(c3Result.result)})`,
    );
  }
  if (!(feedback.error as string).includes("quarantined")) {
    fail(`Feedback error should mention 'quarantined' (got: ${feedback.error})`);
  }
  pass(`Quarantined tool returned ForgeToolErrorFeedback: "${feedback.error}"`);

  // Check 4: Entity tool still works after forged tool quarantine
  if (entityToolCalls.length < 2 || entityToolCalls[1] !== "still works") {
    fail(`Entity tool should work after quarantine (got: ${JSON.stringify(entityToolCalls)})`);
  }
  pass("Entity tool 'echo' still works after forged tool quarantine");

  // Check 5: ForgeStore.update was called with lifecycle: "failed"
  if (callLog.forgeUpdates.length === 0) {
    fail("ForgeStore.update was not called during quarantine");
  }
  const updateCall = callLog.forgeUpdates[0];
  if (updateCall?.id !== "brick-flaky") {
    fail(`ForgeStore.update called with wrong brickId (got: ${updateCall?.id})`);
  }
  const updates = updateCall.updates as Record<string, unknown>;
  if (updates.lifecycle !== "failed") {
    fail(`ForgeStore.update should set lifecycle='failed' (got: ${JSON.stringify(updates)})`);
  }
  pass("ForgeStore.update called with { lifecycle: 'failed' }");

  // Check 6: SnapshotStore.record was called with quarantine event
  if (callLog.snapshotRecords.length === 0) {
    fail("SnapshotStore.record was not called during quarantine");
  }
  const snapshot = callLog.snapshotRecords[0]?.snapshot as Record<string, unknown>;
  const snapshotEvent = snapshot?.event as Record<string, unknown>;
  if (snapshotEvent?.type !== "quarantined") {
    fail(`Snapshot event type should be 'quarantined' (got: ${snapshotEvent?.type})`);
  }
  pass("SnapshotStore.record called with quarantine event");

  // Check 7: onQuarantine callback fired
  if (quarantinedBricks.length === 0) {
    fail("onQuarantine callback was not fired");
  }
  if (quarantinedBricks[0] !== "brick-flaky") {
    fail(`onQuarantine called with wrong brickId (got: ${quarantinedBricks[0]})`);
  }
  pass("onQuarantine callback fired with brickId='brick-flaky'");

  // Check 8: Agent completed successfully
  const doneEvent = events.find((e) => e.kind === "done");
  if (doneEvent?.kind !== "done" || doneEvent.output.stopReason !== "completed") {
    fail(
      `Agent should complete (got: ${doneEvent?.kind === "done" ? doneEvent.output.stopReason : "no done event"})`,
    );
  }
  pass("Agent completed successfully");

  await runtime.dispose();
}

main().catch((error: unknown) => {
  console.error("\nE2E FAILED:", error);
  process.exit(1);
});
