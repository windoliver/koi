/**
 * E2E: Capability injection through the full createKoi runtime.
 *
 * Validates that middleware `describeCapabilities` descriptions are:
 *   1. Collected and aggregated into a system message
 *   2. Injected into the model request before the LLM sees it
 *   3. Visible to the LLM (it can reference the capabilities in its response)
 *   4. Work correctly with tools, streaming, and multiple middleware
 *
 * Uses createPiAdapter (streaming) with a real Anthropic API key.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-capability-injection.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  CapabilityFragment,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  Tool,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

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

function testManifest(): AgentManifest {
  return {
    name: "E2E Capability Injection Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ADD_TOOL: Tool = {
  descriptor: {
    name: "add_numbers",
    description: "Adds two numbers together.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a + b);
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-capability-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Capability middleware factories
// ---------------------------------------------------------------------------

function createFakeBudgetMiddleware(remaining: number, total: number): KoiMiddleware {
  const fragment: CapabilityFragment = {
    label: "budget",
    description: `Token budget: ${remaining} of ${total} remaining`,
  };
  return {
    name: "fake-budget",
    priority: 200,
    describeCapabilities: () => fragment,
  };
}

function createFakePermissionsMiddleware(deniedTools: readonly string[]): KoiMiddleware {
  const fragment: CapabilityFragment = {
    label: "permissions",
    description:
      deniedTools.length > 0
        ? `Tools requiring approval: ${deniedTools.join(", ")}. Default: allow`
        : "All tools allowed. No restrictions.",
  };
  return {
    name: "fake-permissions",
    priority: 100,
    describeCapabilities: () => fragment,
  };
}

function createFakeGuardrailsMiddleware(): KoiMiddleware {
  const fragment: CapabilityFragment = {
    label: "guardrails",
    description: "Output must be valid JSON. Max 3 retries on validation failure.",
  };
  return {
    name: "fake-guardrails",
    priority: 375,
    describeCapabilities: () => fragment,
  };
}

/**
 * Spy middleware that captures the ModelRequest seen by wrapModelStream
 * so we can assert on the injected capability message.
 */
function createRequestCaptureSpy(): {
  readonly middleware: KoiMiddleware;
  readonly getCapturedRequests: () => readonly ModelRequest[];
} {
  const captured: ModelRequest[] = [];
  const middleware: KoiMiddleware = {
    name: "request-capture-spy",
    priority: 999, // innermost — sees the final request after all injection
    wrapModelStream: (
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> => {
      captured.push(request);
      return next(request);
    },
  };
  return { middleware, getCapturedRequests: () => captured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: capability injection through createKoi + createPiAdapter", () => {
  // ── Test 1: Capability message is injected into model request ──────
  test(
    "injects capability system message into the model request",
    async () => {
      const spy = createRequestCaptureSpy();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word: OK",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [
          createFakeBudgetMiddleware(8500, 10000),
          createFakePermissionsMiddleware(["deploy", "delete"]),
          spy.middleware,
        ],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the spy captured at least one request
      const requests = spy.getCapturedRequests();
      expect(requests.length).toBeGreaterThanOrEqual(1);

      // The first request should have the capability message prepended
      const firstRequest = requests[0];
      expect(firstRequest).toBeDefined();
      if (firstRequest === undefined) return;

      // Find the capability message in the request
      const capMsg = firstRequest.messages.find((m) => m.senderId === "system:capabilities");
      expect(capMsg).toBeDefined();
      if (capMsg === undefined) return;

      // Verify it contains both middleware descriptions
      const textContent = capMsg.content
        .filter((c): c is { readonly kind: "text"; readonly text: string } => c.kind === "text")
        .map((c) => c.text)
        .join("");

      expect(textContent).toContain("[Active Capabilities]");
      expect(textContent).toContain("budget");
      expect(textContent).toContain("8500");
      expect(textContent).toContain("permissions");
      expect(textContent).toContain("deploy");

      // Capability message should be the FIRST message in the array
      expect(firstRequest.messages[0]?.senderId).toBe("system:capabilities");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Multiple middleware descriptions are aggregated ────────
  test(
    "aggregates descriptions from multiple middleware in priority order",
    async () => {
      const spy = createRequestCaptureSpy();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [
          createFakePermissionsMiddleware([]), // priority 100
          createFakeBudgetMiddleware(5000, 10000), // priority 200
          createFakeGuardrailsMiddleware(), // priority 375
          spy.middleware, // priority 999
        ],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

      const requests = spy.getCapturedRequests();
      expect(requests.length).toBeGreaterThanOrEqual(1);

      const capMsg = requests[0]?.messages.find((m) => m.senderId === "system:capabilities");
      expect(capMsg).toBeDefined();
      if (capMsg === undefined) return;

      const text = capMsg.content
        .filter((c): c is { readonly kind: "text"; readonly text: string } => c.kind === "text")
        .map((c) => c.text)
        .join("");

      // All three middleware should appear
      expect(text).toContain("permissions");
      expect(text).toContain("budget");
      expect(text).toContain("5000");
      expect(text).toContain("guardrails");
      expect(text).toContain("JSON");

      // Verify order: permissions (100) before budget (200) before guardrails (375)
      const permIdx = text.indexOf("permissions");
      const budgetIdx = text.indexOf("budget");
      const guardIdx = text.indexOf("guardrails");
      expect(permIdx).toBeLessThan(budgetIdx);
      expect(budgetIdx).toBeLessThan(guardIdx);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: LLM can see and reference capabilities ────────────────
  test(
    "LLM references active capabilities when asked about them",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You are an assistant. When asked about your active capabilities, " +
          "read the [Active Capabilities] section in your context and describe them.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [
          createFakeBudgetMiddleware(7500, 10000),
          createFakePermissionsMiddleware(["shell:exec"]),
        ],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What are your active capabilities? Mention the token budget number and any restricted tools.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      // The LLM should mention budget or the specific number
      const mentionsBudget =
        text.includes("7500") || text.includes("7,500") || text.toLowerCase().includes("budget");
      // The LLM should mention the restricted tool
      const mentionsRestriction =
        text.includes("shell:exec") ||
        text.toLowerCase().includes("approval") ||
        text.toLowerCase().includes("restricted");

      expect(mentionsBudget || mentionsRestriction).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Capabilities work alongside tool calls ────────────────
  test(
    "capability injection works correctly when tools are also used",
    async () => {
      const spy = createRequestCaptureSpy();
      // let justified: track tool calls
      let toolCallCount = 0;

      const toolObserver: KoiMiddleware = {
        name: "tool-observer",
        priority: 500,
        wrapToolCall: async (
          _ctx: TurnContext,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallCount++;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the add_numbers tool to answer math questions. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [createFakeBudgetMiddleware(9000, 10000), toolObserver, spy.middleware],
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the add_numbers tool to compute 13 + 29. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Tool should have been called
      expect(toolCallCount).toBeGreaterThanOrEqual(1);

      // Response should contain 42
      const text = extractText(events);
      expect(text).toContain("42");

      // Capability message should be in the first model request
      const requests = spy.getCapturedRequests();
      expect(requests.length).toBeGreaterThanOrEqual(1);

      const capMsg = requests[0]?.messages.find((m) => m.senderId === "system:capabilities");
      expect(capMsg).toBeDefined();

      // Tools should also be present in the request
      expect(requests[0]?.tools).toBeDefined();
      expect(requests[0]?.tools?.length).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: No capability message when no middleware implements it ─
  test(
    "skips capability injection when no middleware has describeCapabilities",
    async () => {
      const spy = createRequestCaptureSpy();

      // Middleware with NO describeCapabilities
      const plainMiddleware: KoiMiddleware = {
        name: "plain-observer",
        priority: 400,
        onAfterTurn: async () => {
          /* no-op */
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word: OK",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [plainMiddleware, spy.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say OK" }));

      const requests = spy.getCapturedRequests();
      expect(requests.length).toBeGreaterThanOrEqual(1);

      // No capability message should be present
      const capMsg = requests[0]?.messages.find((m) => m.senderId === "system:capabilities");
      expect(capMsg).toBeUndefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Dynamic capabilities reflect runtime state ────────────
  test(
    "dynamic describeCapabilities reflects state changes across turns",
    async () => {
      const spy = createRequestCaptureSpy();
      // let justified: mutable counter for dynamic capability
      let callCount = 0;

      const dynamicMiddleware: KoiMiddleware = {
        name: "dynamic-counter",
        priority: 300,
        describeCapabilities: (): CapabilityFragment => ({
          label: "call-counter",
          description: `Model calls so far: ${callCount}`,
        }),
        wrapModelStream: (
          _ctx: TurnContext,
          request: ModelRequest,
          next: ModelStreamHandler,
        ): AsyncIterable<ModelChunk> => {
          callCount++;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the add_numbers tool for math. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [dynamicMiddleware, spy.middleware],
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 5 + 3. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Multiple requests should have been captured (at least 2 if tool was used)
      const requests = spy.getCapturedRequests();

      if (requests.length >= 2) {
        // First request should say "Model calls so far: 0"
        const firstCap = requests[0]?.messages.find((m) => m.senderId === "system:capabilities");
        const firstText = firstCap?.content
          .filter((c): c is { readonly kind: "text"; readonly text: string } => c.kind === "text")
          .map((c) => c.text)
          .join("");
        expect(firstText).toContain("Model calls so far: 0");

        // Second request should say "Model calls so far: 1"
        const secondCap = requests[1]?.messages.find((m) => m.senderId === "system:capabilities");
        const secondText = secondCap?.content
          .filter((c): c is { readonly kind: "text"; readonly text: string } => c.kind === "text")
          .map((c) => c.text)
          .join("");
        expect(secondText).toContain("Model calls so far: 1");
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Real middleware (describeCapabilities) integration ─────
  test(
    "works with a middleware that has both describeCapabilities and wrapToolCall",
    async () => {
      const spy = createRequestCaptureSpy();
      const toolCallLog: string[] = [];

      // Middleware that both describes capabilities AND wraps tool calls
      const auditMiddleware: KoiMiddleware = {
        name: "audit-sim",
        priority: 300,
        describeCapabilities: (): CapabilityFragment => ({
          label: "audit",
          description: "Compliance audit logging active. All tool calls are recorded.",
        }),
        wrapToolCall: async (
          _ctx: TurnContext,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallLog.push(`audit:${request.toolId}`);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the add_numbers tool for math. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [auditMiddleware, spy.middleware],
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 10 + 20. Report the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Capability injection should be present
      const requests = spy.getCapturedRequests();
      const capMsg = requests[0]?.messages.find((m) => m.senderId === "system:capabilities");
      expect(capMsg).toBeDefined();

      const capText = capMsg?.content
        .filter((c): c is { readonly kind: "text"; readonly text: string } => c.kind === "text")
        .map((c) => c.text)
        .join("");
      expect(capText).toContain("audit");
      expect(capText).toContain("Compliance audit logging active");

      // wrapToolCall should have fired
      expect(toolCallLog.length).toBeGreaterThanOrEqual(1);
      expect(toolCallLog[0]).toBe("audit:add_numbers");

      // Response should contain 30
      const text = extractText(events);
      expect(text).toContain("30");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
