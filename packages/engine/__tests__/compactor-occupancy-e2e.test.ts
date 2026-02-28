/**
 * E2E test for CONTEXT_OCCUPANCY governance variable through the full
 * createKoi + createLoopAdapter + createCompactorMiddleware runtime assembly
 * with real Anthropic API calls.
 *
 * Validates:
 * - Compactor middleware wires into the full L1 middleware chain
 * - Occupancy tracking updates after real LLM model calls
 * - Governance contributor is discoverable and registered by governance extension
 * - context_occupancy appears in governance snapshot readings
 * - describeCapabilities returns dynamic occupancy string (Context: N%)
 * - Pressure trend tracker accumulates samples across turns
 * - pressureTrend() returns valid ContextPressureTrend
 * - Multi-turn: occupancy grows and trend reflects growth
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/engine/__tests__/compactor-occupancy-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  GovernanceSnapshot,
  ModelRequest,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { GOVERNANCE, GOVERNANCE_VARIABLES, toolToken } from "@koi/core";
import { createLoopAdapter } from "@koi/engine-loop";
import type { CompactorMiddleware } from "@koi/middleware-compactor";
import { COMPACTOR_GOVERNANCE, createCompactorMiddleware } from "@koi/middleware-compactor";
import { createAnthropicAdapter } from "@koi/model-router";
import { createMockTurnContext } from "@koi/test-utils";
import type { GovernanceControllerBuilder } from "../src/governance-controller.js";
import { createKoi } from "../src/koi.js";
import type { GovernanceConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

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

/** Create the Anthropic model handler wired to a cheap model for testing. */
function createModelCall(): (request: ModelRequest) => Promise<import("@koi/core").ModelResponse> {
  const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (request: ModelRequest) =>
    anthropic.complete({ ...request, model: "claude-haiku-4-5-20251001" });
}

/**
 * Create a ComponentProvider that attaches the compactor's governance
 * contributor to the agent entity, making it discoverable by L1.
 */
function createCompactorGovernanceProvider(mw: CompactorMiddleware): ComponentProvider {
  return {
    name: "compactor-governance",
    async attach(): Promise<ReadonlyMap<string, unknown>> {
      return new Map([[COMPACTOR_GOVERNANCE as string, mw.governanceContributor]]);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: context occupancy through full createKoi + compactor middleware", () => {
  const modelCall = createModelCall();

  test(
    "single-turn: compactor middleware updates occupancy after real LLM call",
    async () => {
      // Use a small context window so even a short message produces a visible %
      // (with 200K window, 29 tokens → Math.round(0.015%) = 0%)
      const compactorMw = createCompactorMiddleware({
        summarizer: modelCall,
        contextWindowSize: 1_000,
        trigger: { messageCount: 100 }, // high threshold — no compaction
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "compactor-e2e-single-turn",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [compactorMw],
        providers: [createCompactorGovernanceProvider(compactorMw)],
        loopDetection: false,
      });

      // Run a simple single-turn interaction
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify text response came through
      const text = extractTextFromEvents(events);
      expect(text.length).toBeGreaterThan(0);

      // --- Occupancy tracking assertions ---

      // 1. governanceContributor.variables()[0].read() should be > 0 after real call
      const variable = compactorMw.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      expect(variable.name).toBe(GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY);
      expect(variable.read()).toBeGreaterThan(0);

      // 2. check() should always return {ok: true} (informational only)
      expect(variable.check()).toEqual({ ok: true });

      // 3. limit should equal contextWindowSize
      expect(variable.limit).toBe(1_000);

      // 4. pressureTrend should have exactly 1 sample (single turn)
      const trend = compactorMw.pressureTrend();
      expect(trend.sampleCount).toBe(1);
      expect(trend.estimatedTurnsToCompaction).toBe(-1); // need 2+ samples

      // 5. describeCapabilities should show non-zero %
      const caps = compactorMw.describeCapabilities?.(createMockTurnContext());
      expect(caps?.description).toMatch(/Context: \d+%/);
      expect(caps?.description).not.toMatch(/Context: 0%/);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "governance snapshot includes context_occupancy reading from L2 contributor",
    async () => {
      const compactorMw = createCompactorMiddleware({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });

      const governanceConfig: Partial<GovernanceConfig> = {
        iteration: {
          maxTurns: 10,
          maxTokens: 500_000,
          maxDurationMs: 120_000,
        },
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "compactor-e2e-governance-snapshot",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [compactorMw],
        providers: [createCompactorGovernanceProvider(compactorMw)],
        governance: governanceConfig,
        loopDetection: false,
      });

      // Run
      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // Read the governance controller
      const controller = runtime.agent.component<GovernanceControllerBuilder>(
        GOVERNANCE as SubsystemToken<GovernanceControllerBuilder>,
      );
      expect(controller).toBeDefined();
      if (controller === undefined) return;
      expect(controller.sealed).toBe(true);

      // Take snapshot — should include context_occupancy
      const snapshot: GovernanceSnapshot = await controller.snapshot();
      expect(snapshot.healthy).toBe(true);

      // Verify context_occupancy is in the readings
      const occupancyReading = snapshot.readings.find(
        (r) => r.name === GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY,
      );
      expect(occupancyReading).toBeDefined();
      if (occupancyReading !== undefined) {
        // After a real LLM call, occupancy should be > 0
        expect(occupancyReading.current).toBeGreaterThan(0);
        expect(occupancyReading.limit).toBe(200_000);
        // Utilization should be between 0 and 1
        expect(occupancyReading.utilization).toBeGreaterThan(0);
        expect(occupancyReading.utilization).toBeLessThan(1);
      }

      // Verify all built-in variables + our new one
      const variableNames = snapshot.readings.map((r) => r.name);
      expect(variableNames).toContain(GOVERNANCE_VARIABLES.TURN_COUNT);
      expect(variableNames).toContain(GOVERNANCE_VARIABLES.TOKEN_USAGE);
      expect(variableNames).toContain(GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY);

      // Verify through the controller.variables() map too
      const vars = controller.variables();
      expect(vars.has(GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY)).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "multi-turn with tool call: occupancy grows and pressure trend tracks growth",
    async () => {
      // Register a tool that forces multi-turn
      const echoTool: Tool = {
        descriptor: {
          name: "echo",
          description: "Returns the input text back. ALWAYS use this tool when asked to echo.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to echo" },
            },
            required: ["text"],
          },
        },
        trustTier: "sandbox",
        execute: async (input: Readonly<Record<string, unknown>>) => {
          return String(input.text ?? "");
        },
      };

      const toolProvider: ComponentProvider = {
        name: "echo-tool",
        async attach(): Promise<ReadonlyMap<string, unknown>> {
          return new Map([[toolToken("echo") as string, echoTool]]);
        },
      };

      const compactorMw = createCompactorMiddleware({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
      const runtime = await createKoi({
        manifest: {
          name: "compactor-e2e-multi-turn",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [compactorMw],
        providers: [toolProvider, createCompactorGovernanceProvider(compactorMw)],
        loopDetection: false,
      });

      // Prompt that encourages tool use → multi-turn
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the echo tool to echo 'hello world', then say the result back to me.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // After multi-turn, occupancy should be higher
      const variable = compactorMw.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      const occupancy = variable.read();
      expect(occupancy).toBeGreaterThan(0);

      // Pressure trend should have samples
      const trend = compactorMw.pressureTrend();
      expect(trend.sampleCount).toBeGreaterThanOrEqual(1);

      // If tool was called (multi-turn), we should have 2+ samples
      const toolCallEvents = events.filter((e) => e.kind === "tool_call_start");
      if (toolCallEvents.length > 0) {
        // Multi-turn happened — verify growth tracking
        expect(trend.sampleCount).toBeGreaterThanOrEqual(2);
        // Growth should be non-negative (context grows with each turn)
        expect(trend.growthPerTurn).toBeGreaterThanOrEqual(0);
      }

      // describeCapabilities should show updated occupancy
      const caps = compactorMw.describeCapabilities?.(createMockTurnContext());
      expect(caps?.label).toBe("compactor");
      expect(caps?.description).toMatch(/Context: \d+%/);

      // If we have 2+ samples, should include K/turn in description
      if (trend.sampleCount >= 2) {
        expect(caps?.description).toMatch(/K\/turn/);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "occupancy check() is always ok even with high occupancy",
    async () => {
      // Small context window so occupancy will be high after real call
      const compactorMw = createCompactorMiddleware({
        summarizer: modelCall,
        contextWindowSize: 500, // Very small — real call will fill most of it
        trigger: { messageCount: 100 },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 2 });
      const runtime = await createKoi({
        manifest: {
          name: "compactor-e2e-high-occupancy",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [compactorMw],
        providers: [createCompactorGovernanceProvider(compactorMw)],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // Even with very high occupancy, check() should return {ok: true}
      const variable = compactorMw.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      expect(variable.check()).toEqual({ ok: true });

      // Occupancy should be very high relative to tiny window
      const occupancy = variable.read();
      expect(occupancy).toBeGreaterThan(0);

      // Through the governance controller, it should not produce violations
      const controller = runtime.agent.component<GovernanceControllerBuilder>(
        GOVERNANCE as SubsystemToken<GovernanceControllerBuilder>,
      );
      if (controller !== undefined) {
        const snapshot = await controller.snapshot();
        // context_occupancy should NOT cause violations (informational only)
        const occupancyViolation = snapshot.violations.find((v) => v.includes("context_occupancy"));
        expect(occupancyViolation).toBeUndefined();
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "describeCapabilities integrates with system prompt injection",
    async () => {
      // Small context window so short messages produce visible % after rounding
      const compactorMw = createCompactorMiddleware({
        summarizer: modelCall,
        contextWindowSize: 1_000,
        trigger: { messageCount: 100 },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 2 });
      const runtime = await createKoi({
        manifest: {
          name: "compactor-e2e-capabilities",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [compactorMw],
        providers: [createCompactorGovernanceProvider(compactorMw)],
        loopDetection: false,
      });

      // Before any model call — occupancy starts at 0%
      const capsBefore = compactorMw.describeCapabilities?.(createMockTurnContext());
      expect(capsBefore?.description).toMatch(/Context: 0%/);
      expect(capsBefore?.description).toMatch(/0K\/1K/);

      // After a model call
      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // Verify tracking updated (underlying value, not display string)
      const variable = compactorMw.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      expect(variable.read()).toBeGreaterThan(0);

      const capsAfter = compactorMw.describeCapabilities?.(createMockTurnContext());
      expect(capsAfter?.description).toMatch(/Context: \d+%/);
      // With 1K window, even a short message will show non-zero %
      expect(capsAfter?.description).not.toMatch(/Context: 0%/);
      // Should mention compaction threshold
      expect(capsAfter?.description).toMatch(/Compaction above/);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "middleware chain order: compactor runs alongside governance guard",
    async () => {
      const compactorMw = createCompactorMiddleware({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });

      const governanceConfig: Partial<GovernanceConfig> = {
        iteration: {
          maxTurns: 10,
          maxTokens: 500_000,
          maxDurationMs: 120_000,
        },
        cost: {
          maxCostUsd: 1.0,
          costPerInputToken: 0.000001,
          costPerOutputToken: 0.000005,
        },
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "compactor-e2e-chain-order",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [compactorMw],
        providers: [createCompactorGovernanceProvider(compactorMw)],
        governance: governanceConfig,
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Both governance and compactor middleware ran
      const controller = runtime.agent.component<GovernanceControllerBuilder>(
        GOVERNANCE as SubsystemToken<GovernanceControllerBuilder>,
      );
      expect(controller).toBeDefined();
      if (controller === undefined) return;

      const snapshot = await controller.snapshot();

      // Built-in governance variables tracked
      const turnReading = snapshot.readings.find((r) => r.name === GOVERNANCE_VARIABLES.TURN_COUNT);
      expect(turnReading?.current).toBeGreaterThanOrEqual(1);

      const tokenReading = snapshot.readings.find(
        (r) => r.name === GOVERNANCE_VARIABLES.TOKEN_USAGE,
      );
      expect(tokenReading?.current).toBeGreaterThan(0);

      // Compactor's context_occupancy also tracked
      const occupancyReading = snapshot.readings.find(
        (r) => r.name === GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY,
      );
      expect(occupancyReading).toBeDefined();
      expect(occupancyReading?.current).toBeGreaterThan(0);

      // Both cost and occupancy coexist without conflict
      const costReading = snapshot.readings.find((r) => r.name === GOVERNANCE_VARIABLES.COST_USD);
      expect(costReading).toBeDefined();
      expect(costReading?.current).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
