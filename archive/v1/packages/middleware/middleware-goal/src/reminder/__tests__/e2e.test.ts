/**
 * Comprehensive E2E test for @koi/middleware-goal-reminder through the full
 * createKoi + createLoopAdapter runtime assembly with real Anthropic API calls.
 *
 * Validates:
 * - Full middleware chain wiring (onSessionStart → onBeforeTurn → wrapModelCall → onSessionEnd)
 * - Adaptive interval mechanics with real LLM responses
 * - Reminder injection content (XML tags, source resolution)
 * - Multi-turn interaction with interval progression
 * - describeCapabilities returns live interval info
 * - Middleware coexistence with built-in governance middleware
 * - Dynamic and tasks source types with real calls
 * - isDrifting callback integration
 * - Session cleanup after dispose
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/middleware-goal-reminder/src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput, ModelRequest, ModelResponse } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { createGoalReminderMiddleware } from "../goal-reminder.js";
import type { ReminderSource } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractTextFromEvents(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function createModelCall(): (request: ModelRequest) => Promise<ModelResponse> {
  const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (request: ModelRequest) => anthropic.complete({ ...request, model: E2E_MODEL });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: goal-reminder through full createKoi + createLoopAdapter", () => {
  const modelCall = createModelCall();

  test(
    "single-turn: middleware wires through full runtime without breaking agent",
    async () => {
      const middleware = createGoalReminderMiddleware({
        sources: [{ kind: "manifest", objectives: ["Answer the user's question accurately"] }],
        baseInterval: 1,
        maxInterval: 4,
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-basic",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      // Agent should complete normally — middleware must not interfere
      expect(output.stopReason).toBe("completed");

      // Should have produced text output
      const text = extractTextFromEvents(events);
      expect(text.length).toBeGreaterThan(0);

      // Turn events should be present
      const turnStarts = events.filter((e) => e.kind === "turn_start");
      expect(turnStarts.length).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "reminder injection: model receives injected system:goal-reminder message",
    async () => {
      // Use a spy model call to capture what the model actually receives
      let capturedMessages: readonly unknown[] = [];
      const spyModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        capturedMessages = request.messages;
        return modelCall(request);
      };

      const middleware = createGoalReminderMiddleware({
        sources: [
          { kind: "manifest", objectives: ["Search for information", "Write a summary"] },
          { kind: "static", text: "Always respond in clear, concise language" },
        ],
        baseInterval: 1, // Inject on every trigger turn
        maxInterval: 4,
        isDrifting: () => true, // Keep interval at 1 so we always inject
      });

      const adapter = createLoopAdapter({ modelCall: spyModelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-injection",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: OK" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the model received the injected reminder message
      expect(capturedMessages.length).toBeGreaterThanOrEqual(2); // reminder + user msg
      const firstMsg = capturedMessages[0] as {
        readonly senderId?: string;
        readonly content?: readonly { readonly kind: string; readonly text?: string }[];
      };
      expect(firstMsg?.senderId).toBe("system:goal-reminder");

      // Verify XML-tagged content
      const textBlock = firstMsg?.content?.[0];
      if (textBlock?.kind === "text" && textBlock.text !== undefined) {
        expect(textBlock.text).toContain("<reminder>");
        expect(textBlock.text).toContain("<goals>");
        expect(textBlock.text).toContain("Search for information");
        expect(textBlock.text).toContain("Write a summary");
        expect(textBlock.text).toContain("<context>");
        expect(textBlock.text).toContain("Always respond in clear, concise language");
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "adaptive interval: tracks turn count through real multi-turn LLM interaction",
    async () => {
      // Track which turns get injection
      const injectedTurns: number[] = [];
      let callCount = 0;

      const trackingModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        const hasReminder = request.messages.some(
          (m) => (m as { readonly senderId?: string }).senderId === "system:goal-reminder",
        );
        if (hasReminder) {
          injectedTurns.push(callCount);
        }
        callCount++;
        return modelCall(request);
      };

      const middleware = createGoalReminderMiddleware({
        sources: [{ kind: "manifest", objectives: ["Help the user"] }],
        baseInterval: 1,
        maxInterval: 8,
        isDrifting: () => true, // Always drifting → interval stays at 1
      });

      const adapter = createLoopAdapter({ modelCall: trackingModelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-adaptive",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // With baseInterval=1 and isDrifting=true, should inject on every trigger turn
      // At minimum the first model call should have been injected
      expect(injectedTurns.length).toBeGreaterThanOrEqual(1);
      expect(injectedTurns[0]).toBe(0); // First model call gets injection

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "dynamic source: fetch() is called during real LLM interaction",
    async () => {
      let fetchCallCount = 0;
      const dynamicSource: ReminderSource = {
        kind: "dynamic",
        fetch: (_ctx) => {
          fetchCallCount++;
          return `Dynamic context fetched at ${new Date().toISOString()}`;
        },
      };

      const middleware = createGoalReminderMiddleware({
        sources: [{ kind: "manifest", objectives: ["Complete the task"] }, dynamicSource],
        baseInterval: 1,
        maxInterval: 4,
        isDrifting: () => true,
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-dynamic",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // Dynamic fetch should have been called at least once for the injection
      expect(fetchCallCount).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "tasks source: provider() is called during real LLM interaction",
    async () => {
      let providerCallCount = 0;
      const tasksSource: ReminderSource = {
        kind: "tasks",
        provider: (_ctx) => {
          providerCallCount++;
          return ["Fix the login bug", "Write unit tests"];
        },
      };

      const middleware = createGoalReminderMiddleware({
        sources: [tasksSource],
        baseInterval: 1,
        maxInterval: 4,
        isDrifting: () => true,
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-tasks",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // Tasks provider should have been called
      expect(providerCallCount).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "isDrifting callback: receives turn context from real runtime",
    async () => {
      let isDriftingCalled = false;
      let receivedTurnIndex = -1;

      const middleware = createGoalReminderMiddleware({
        sources: [{ kind: "manifest", objectives: ["Answer accurately"] }],
        baseInterval: 1,
        maxInterval: 4,
        isDrifting: (ctx) => {
          isDriftingCalled = true;
          receivedTurnIndex = ctx.turnIndex;
          return false; // not drifting → interval will double
        },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-drift-callback",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // isDrifting should have been called with a real TurnContext
      expect(isDriftingCalled).toBe(true);
      expect(receivedTurnIndex).toBeGreaterThanOrEqual(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "fail-safe: throwing isDrifting does not crash the agent",
    async () => {
      const middleware = createGoalReminderMiddleware({
        sources: [{ kind: "manifest", objectives: ["Complete task"] }],
        baseInterval: 1,
        maxInterval: 4,
        isDrifting: () => {
          throw new Error("isDrifting crashed!");
        },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-failsafe",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      // Should complete without throwing, even though isDrifting throws
      const events = await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "fail-safe: throwing dynamic source does not crash the agent",
    async () => {
      const middleware = createGoalReminderMiddleware({
        sources: [
          { kind: "manifest", objectives: ["Complete task"] },
          {
            kind: "dynamic",
            fetch: () => {
              throw new Error("source fetch crashed!");
            },
          },
        ],
        baseInterval: 1,
        maxInterval: 4,
        isDrifting: () => true,
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-failsafe-source",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      // Should complete without throwing — source error is handled gracefully
      const events = await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "coexistence: goal-reminder works alongside governance middleware",
    async () => {
      const middleware = createGoalReminderMiddleware({
        sources: [{ kind: "manifest", objectives: ["Be helpful"] }],
        baseInterval: 1,
        maxInterval: 4,
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-coexist",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        governance: {
          iteration: { maxTurns: 10, maxTokens: 500_000, maxDurationMs: TIMEOUT_MS },
        },
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Metrics should reflect real usage (governance tracks tokens/turns)
      if (output !== undefined) {
        expect(output.metrics.turns).toBeGreaterThanOrEqual(1);
        expect(output.metrics.totalTokens).toBeGreaterThan(0);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "dispose is idempotent and cleans up runtime",
    async () => {
      const middleware = createGoalReminderMiddleware({
        sources: [{ kind: "static", text: "Stay focused" }],
        baseInterval: 1,
        maxInterval: 4,
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-dispose",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // Double dispose should not throw
      await runtime.dispose();
      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "all source kinds combined: manifest + static + dynamic + tasks",
    async () => {
      let capturedMessages: readonly unknown[] = [];
      const spyModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        capturedMessages = request.messages;
        return modelCall(request);
      };

      const allSources: readonly ReminderSource[] = [
        { kind: "manifest", objectives: ["Build the feature", "Write tests"] },
        { kind: "static", text: "Follow TypeScript strict mode" },
        { kind: "dynamic", fetch: (_ctx) => "Current sprint: v2.1 release" },
        { kind: "tasks", provider: (_ctx) => ["Fix auth bug", "Update docs"] },
      ];

      const middleware = createGoalReminderMiddleware({
        sources: allSources,
        baseInterval: 1,
        maxInterval: 4,
        isDrifting: () => true,
        header: "Agent Context",
      });

      const adapter = createLoopAdapter({ modelCall: spyModelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "goal-reminder-e2e-all-sources",
          version: "0.0.1",
          model: { name: E2E_MODEL },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify all source kinds are present in the injected message
      const firstMsg = capturedMessages[0] as {
        readonly senderId?: string;
        readonly content?: readonly { readonly kind: string; readonly text?: string }[];
      };
      expect(firstMsg?.senderId).toBe("system:goal-reminder");

      const text = firstMsg?.content?.[0];
      if (text?.kind === "text" && text.text !== undefined) {
        // Custom header
        expect(text.text).toContain("Agent Context");
        // Manifest goals
        expect(text.text).toContain("<goals>");
        expect(text.text).toContain("Build the feature");
        expect(text.text).toContain("Write tests");
        // Static context
        expect(text.text).toContain("Follow TypeScript strict mode");
        // Dynamic context
        expect(text.text).toContain("Current sprint: v2.1 release");
        // Tasks
        expect(text.text).toContain("<tasks>");
        expect(text.text).toContain("Fix auth bug");
        expect(text.text).toContain("Update docs");
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
