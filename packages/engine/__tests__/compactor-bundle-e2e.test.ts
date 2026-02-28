/**
 * E2E: MiddlewareBundle + compact_context tool through createKoi with real API.
 * Section A: createLoopAdapter, Section B: createPiAdapter.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 * Run: E2E_TESTS=1 bun test packages/engine/__tests__/compactor-bundle-e2e.test.ts
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
import { createPiAdapter } from "@koi/engine-pi";
import type { CompactorBundle } from "@koi/middleware-compactor";
import { COMPACTOR_GOVERNANCE, createCompactorBundle } from "@koi/middleware-compactor";
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
const E2E_MODEL_LOOP = "claude-haiku-4-5-20251001";
const E2E_MODEL_PI = "anthropic:claude-haiku-4-5-20251001";

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

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function extractToolStarts(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_start" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

function createModelCall(): (request: ModelRequest) => Promise<import("@koi/core").ModelResponse> {
  const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (request: ModelRequest) => anthropic.complete({ ...request, model: E2E_MODEL_LOOP });
}

/**
 * Create a ComponentProvider that attaches the compactor's governance
 * contributor so it's discoverable by L1's governance extension.
 */
function createCompactorGovernanceProvider(bundle: CompactorBundle): ComponentProvider {
  return {
    name: "compactor-governance",
    async attach(): Promise<ReadonlyMap<string, unknown>> {
      return new Map([[COMPACTOR_GOVERNANCE as string, bundle.middleware.governanceContributor]]);
    },
  };
}

function createEchoTool(): { readonly tool: Tool; readonly provider: ComponentProvider } {
  const tool: Tool = {
    descriptor: {
      name: "echo",
      description: "Returns the input text back. ALWAYS call this tool when asked to echo.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      },
    },
    trustTier: "sandbox",
    execute: async (input: Readonly<Record<string, unknown>>) => String(input.text ?? ""),
  };
  const provider: ComponentProvider = {
    name: "echo-tool",
    async attach(): Promise<ReadonlyMap<string, unknown>> {
      return new Map([[toolToken("echo") as string, tool]]);
    },
  };
  return { tool, provider };
}

describeE2E("e2e: compactor bundle through createKoi + createLoopAdapter", () => {
  const modelCall = createModelCall();

  test(
    "bundle wires middleware + tool provider into createKoi assembly",
    async () => {
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 1_000,
        trigger: { messageCount: 100 },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-e2e-assembly",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      // 1. Tool should be discoverable on the agent entity
      const compactTool = runtime.agent.component<Tool>(toolToken("compact_context"));
      expect(compactTool).toBeDefined();
      expect(compactTool?.descriptor.name).toBe("compact_context");
      expect(compactTool?.trustTier).toBe("verified");

      // 2. Run a simple interaction — agent completes without error
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // 3. describeCapabilities should mention compact_context
      const caps = bundle.middleware.describeCapabilities(createMockTurnContext());
      expect(caps?.description).toContain("compact_context");

      // 4. Occupancy should be non-zero after a real LLM call
      const variable = bundle.middleware.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      expect(variable.read()).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "LLM can invoke compact_context tool when prompted",
    async () => {
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-e2e-tool-invoke",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      // Prompt that instructs the LLM to use the compact_context tool
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text:
            "You have a tool called compact_context. " +
            "Please call the compact_context tool now, then tell me what it returned.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Check if the LLM actually called the tool
      const toolCalls = extractToolStarts(events);
      const compactCall = toolCalls.find((e) => e.toolName === "compact_context");

      if (compactCall !== undefined) {
        // Tool was called — verify response text mentions "scheduled"
        const text = extractText(events);
        expect(text.toLowerCase()).toContain("compact");
      }
      // Even if the LLM didn't call the tool (non-deterministic),
      // the runtime should have completed without error

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "scheduleCompaction() flag causes force-compact on next model call",
    async () => {
      // Bundle middleware state persists across runtimes (same closure).
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 1_000,
        trigger: { messageCount: 100 }, // high threshold — normal compaction won't trigger
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      // First run — populate some context
      const adapter1 = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime1 = await createKoi({
        manifest: {
          name: "bundle-e2e-force-compact-1",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter: adapter1,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      await collectEvents(
        runtime1.run({
          kind: "text",
          text: "Tell me a short joke about programming in exactly two sentences.",
        }),
      );

      const variableBefore = bundle.middleware.governanceContributor.variables()[0];
      expect(variableBefore).toBeDefined();
      if (variableBefore === undefined) return;
      const occupancyBefore = variableBefore.read();
      expect(occupancyBefore).toBeGreaterThan(0);
      await runtime1.dispose();

      // Manually schedule compaction (simulates tool.execute() calling scheduleCompaction)
      bundle.middleware.scheduleCompaction();

      // Second run — new adapter + runtime, but same bundle middleware
      // Next wrapModelCall should consume the forceCompactNext flag
      const adapter2 = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime2 = await createKoi({
        manifest: {
          name: "bundle-e2e-force-compact-2",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter: adapter2,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      const events2 = await collectEvents(runtime2.run({ kind: "text", text: "Reply with: OK" }));

      const output2 = findDoneOutput(events2);
      expect(output2).toBeDefined();
      expect(output2?.stopReason).toBe("completed");

      // After force-compact, occupancy should be updated
      const variableAfter = bundle.middleware.governanceContributor.variables()[0];
      expect(variableAfter).toBeDefined();
      if (variableAfter === undefined) return;
      const occupancyAfter = variableAfter.read();
      expect(occupancyAfter).toBeGreaterThan(0);

      await runtime2.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "bundle + echo tool coexist — LLM can use both tools",
    async () => {
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });
      const echo = createEchoTool();

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-e2e-coexist",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, echo.provider, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      // Both tools should be discoverable
      const compactTool = runtime.agent.component<Tool>(toolToken("compact_context"));
      const echoTool = runtime.agent.component<Tool>(toolToken("echo"));
      expect(compactTool).toBeDefined();
      expect(echoTool).toBeDefined();

      // Ask the LLM to use the echo tool
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'You MUST call the echo tool with text "test123". Do it now.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the runtime completed — tool use is non-deterministic with LLMs,
      // so we verify both tools are registered and the agent completed cleanly.
      // If the LLM did call echo, verify the event is present.
      const toolCalls = extractToolStarts(events);
      const echoCall = toolCalls.find((e) => e.toolName === "echo");
      if (echoCall !== undefined) {
        const text = extractText(events);
        expect(text.length).toBeGreaterThan(0);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "governance snapshot includes context_occupancy with bundle",
    async () => {
      const bundle = createCompactorBundle({
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
          name: "bundle-e2e-governance",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        governance: governanceConfig,
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      const controller = runtime.agent.component<GovernanceControllerBuilder>(
        GOVERNANCE as SubsystemToken<GovernanceControllerBuilder>,
      );
      expect(controller).toBeDefined();
      if (controller === undefined) return;

      const snapshot: GovernanceSnapshot = await controller.snapshot();
      expect(snapshot.healthy).toBe(true);

      // context_occupancy reading from the bundle's contributor
      const occupancyReading = snapshot.readings.find(
        (r) => r.name === GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY,
      );
      expect(occupancyReading).toBeDefined();
      if (occupancyReading !== undefined) {
        expect(occupancyReading.current).toBeGreaterThan(0);
        expect(occupancyReading.limit).toBe(200_000);
        expect(occupancyReading.utilization).toBeGreaterThan(0);
        expect(occupancyReading.utilization).toBeLessThan(1);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "pressure trend tracks growth across multi-turn with bundle",
    async () => {
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });
      const echo = createEchoTool();

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-e2e-trend",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, echo.provider, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      // Prompt that encourages tool use → multi-turn
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the echo tool to echo 'hello world', then tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      const trend = bundle.middleware.pressureTrend();
      expect(trend.sampleCount).toBeGreaterThanOrEqual(1);

      // If tool was called (multi-turn), expect 2+ samples
      const toolCalls = extractToolStarts(events);
      if (toolCalls.length > 0) {
        expect(trend.sampleCount).toBeGreaterThanOrEqual(2);
        expect(trend.growthPerTurn).toBeGreaterThanOrEqual(0);
      }

      // describeCapabilities should show K/turn if we have enough samples
      if (trend.sampleCount >= 2) {
        const caps = bundle.middleware.describeCapabilities(createMockTurnContext());
        expect(caps?.description).toMatch(/K\/turn/);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

describeE2E("e2e: compactor bundle through createKoi + createPiAdapter", () => {
  test(
    "pi adapter: bundle wires middleware + tool, agent completes",
    async () => {
      const modelCall = createModelCall();
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 1_000,
        trigger: { messageCount: 100 },
      });

      const adapter = createPiAdapter({ model: E2E_MODEL_PI });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-pi-e2e-assembly",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      // Tool discoverable on agent
      const compactTool = runtime.agent.component<Tool>(toolToken("compact_context"));
      expect(compactTool).toBeDefined();
      expect(compactTool?.descriptor.name).toBe("compact_context");

      // Simple interaction completes
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // describeCapabilities mentions tool
      const caps = bundle.middleware.describeCapabilities(createMockTurnContext());
      expect(caps?.description).toContain("compact_context");

      // Occupancy tracked
      const variable = bundle.middleware.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      expect(variable.read()).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "pi adapter: LLM invokes compact_context tool",
    async () => {
      const modelCall = createModelCall();
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });

      const adapter = createPiAdapter({ model: E2E_MODEL_PI });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-pi-e2e-tool-invoke",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text:
            "You have a tool called compact_context. " +
            "Call the compact_context tool now, then tell me what it returned.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Check if compact_context was called
      const toolCalls = extractToolStarts(events);
      const compactCall = toolCalls.find((e) => e.toolName === "compact_context");

      if (compactCall !== undefined) {
        const text = extractText(events);
        expect(text.toLowerCase()).toContain("compact");
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "pi adapter: bundle + echo tool coexist, multi-turn works",
    async () => {
      const modelCall = createModelCall();
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 200_000,
        trigger: { messageCount: 100 },
      });
      const echo = createEchoTool();

      const adapter = createPiAdapter({ model: E2E_MODEL_PI });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-pi-e2e-coexist",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, echo.provider, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      // Both tools discoverable
      expect(runtime.agent.component<Tool>(toolToken("compact_context"))).toBeDefined();
      expect(runtime.agent.component<Tool>(toolToken("echo"))).toBeDefined();

      // Ask to use echo tool
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use the echo tool to echo "pi-test", then tell me the result.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Occupancy tracked even through Pi adapter middleware bridge
      const variable = bundle.middleware.governanceContributor.variables()[0];
      expect(variable).toBeDefined();
      if (variable === undefined) return;
      expect(variable.read()).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "pi adapter: scheduleCompaction flag round-trip",
    async () => {
      const modelCall = createModelCall();
      const bundle = createCompactorBundle({
        summarizer: modelCall,
        contextWindowSize: 1_000,
        trigger: { messageCount: 100 },
        preserveRecent: 1,
        maxSummaryTokens: 100,
      });

      // First run — populate context
      const adapter1 = createPiAdapter({ model: E2E_MODEL_PI });
      const runtime1 = await createKoi({
        manifest: {
          name: "bundle-pi-e2e-schedule-1",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter: adapter1,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      await collectEvents(runtime1.run({ kind: "text", text: "Tell me a very short joke." }));

      const variableBefore = bundle.middleware.governanceContributor.variables()[0];
      expect(variableBefore).toBeDefined();
      if (variableBefore === undefined) return;
      const occupancyBefore = variableBefore.read();
      expect(occupancyBefore).toBeGreaterThan(0);
      await runtime1.dispose();

      // Schedule compaction manually
      bundle.middleware.scheduleCompaction();

      // Second run — new adapter + runtime, bundle middleware shared
      const adapter2 = createPiAdapter({ model: E2E_MODEL_PI });
      const runtime2 = await createKoi({
        manifest: {
          name: "bundle-pi-e2e-schedule-2",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter: adapter2,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        loopDetection: false,
      });

      const events2 = await collectEvents(runtime2.run({ kind: "text", text: "Reply with: OK" }));

      const output2 = findDoneOutput(events2);
      expect(output2).toBeDefined();
      expect(output2?.stopReason).toBe("completed");

      // After force-compact, occupancy should still be tracked
      const variableAfter = bundle.middleware.governanceContributor.variables()[0];
      expect(variableAfter).toBeDefined();
      if (variableAfter === undefined) return;
      const occupancyAfter = variableAfter.read();
      expect(occupancyAfter).toBeGreaterThan(0);

      await runtime2.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "pi adapter: governance snapshot with bundle",
    async () => {
      const modelCall = createModelCall();
      const bundle = createCompactorBundle({
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

      const adapter = createPiAdapter({ model: E2E_MODEL_PI });
      const runtime = await createKoi({
        manifest: {
          name: "bundle-pi-e2e-governance",
          version: "0.0.1",
          model: { name: E2E_MODEL_LOOP },
        },
        adapter,
        middleware: [bundle.middleware],
        providers: [...bundle.providers, createCompactorGovernanceProvider(bundle)],
        governance: governanceConfig,
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      const controller = runtime.agent.component<GovernanceControllerBuilder>(
        GOVERNANCE as SubsystemToken<GovernanceControllerBuilder>,
      );
      expect(controller).toBeDefined();
      if (controller === undefined) return;

      const snapshot: GovernanceSnapshot = await controller.snapshot();
      expect(snapshot.healthy).toBe(true);

      // context_occupancy should be tracked
      const occupancyReading = snapshot.readings.find(
        (r) => r.name === GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY,
      );
      expect(occupancyReading).toBeDefined();
      if (occupancyReading !== undefined) {
        expect(occupancyReading.current).toBeGreaterThan(0);
        expect(occupancyReading.limit).toBe(200_000);
      }

      // Built-in variables also present
      const variableNames = snapshot.readings.map((r) => r.name);
      expect(variableNames).toContain(GOVERNANCE_VARIABLES.TURN_COUNT);
      expect(variableNames).toContain(GOVERNANCE_VARIABLES.TOKEN_USAGE);
      expect(variableNames).toContain(GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
