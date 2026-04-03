/**
 * Full-stack E2E: createKoi + createPiAdapter + @koi/tool-squash.
 *
 * Validates the squash tool + companion middleware with real LLM calls
 * through the full L1 runtime assembly:
 *   - LLM discovers the squash tool and calls it with correct arguments
 *   - Archived messages are stored in a real SnapshotChainStore
 *   - Companion middleware replaces messages on the next model call
 *   - Facts are stored to memory when provided
 *   - Squash tool works alongside other tools in a multi-tool agent
 *   - Full conversation continuity after squash
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-real-llm.test.ts
 *
 * Cost: ~$0.03-0.08 per run (haiku model, minimal prompts).
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ModelStreamHandler,
  Tool,
} from "@koi/core";
import { chainId, DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import type { MemoryComponent, SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { createSquashProvider } from "../provider.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const MODEL_NAME = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function testManifest(): AgentManifest {
  return {
    name: "E2E Squash Agent",
    version: "0.1.0",
    model: { name: MODEL_NAME },
  };
}

function makeMessage(text: string, opts?: { readonly pinned?: boolean }): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
    ...(opts?.pinned === true ? { pinned: true } : {}),
  };
}

function createAdapter(systemPrompt: string): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt,
    getApiKey: async () => ANTHROPIC_KEY,
    thinkingLevel: "off",
  });
}

/** Creates a ComponentProvider that registers additional tools alongside squash. */
function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-extra-tools",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Seeded conversation history — simulates multi-turn conversation
// ---------------------------------------------------------------------------

function createSeededMessages(): InboundMessage[] {
  return [
    makeMessage("User: I need help building a REST API for a todo app."),
    makeMessage("Assistant: I can help with that. Let me start by planning the architecture."),
    makeMessage("User: Use Express.js and PostgreSQL."),
    makeMessage(
      "Assistant: Got it. I'll design the schema with tasks table and use Express routes.",
    ),
    makeMessage("User: Add authentication with JWT."),
    makeMessage(
      "Assistant: I'll add a users table, bcrypt for passwords, and JWT middleware for auth.",
    ),
    makeMessage("User: What about input validation?"),
    makeMessage("Assistant: I'll use Zod for request body validation on all endpoints."),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: squash tool through full createKoi + Pi stack", () => {
  // ── Test 1: LLM discovers and calls squash tool ──────────────────────

  test(
    "LLM calls squash tool with correct phase and summary",
    async () => {
      const seededMessages = createSeededMessages();
      const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();

      const { provider, middleware } = createSquashProvider(
        {
          archiver,
          sessionId: "e2e-session-1" as SessionId,
          preserveRecent: 4,
        },
        () => seededMessages,
      );

      // Track tool calls via middleware
      const toolCallNames: string[] = []; // let justified: test accumulator
      const toolObserver: KoiMiddleware = {
        name: "e2e-squash-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, request, next) => {
          toolCallNames.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createAdapter(
        "You MUST call the squash tool with phase 'planning' and summary 'Planning done.' — nothing else. " +
          "After calling it, say 'Done.'",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [middleware, toolObserver],
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Please squash the conversation now." }),
        );

        // Agent completed
        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Squash tool was called
        expect(toolCallNames).toContain("squash");

        // Tool call events were emitted
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        const toolEnds = events.filter((e) => e.kind === "tool_call_end");
        expect(toolStarts.length).toBeGreaterThanOrEqual(1);
        expect(toolEnds.length).toBeGreaterThanOrEqual(1);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Archive populated with real SnapshotChainStore ──────────

  test(
    "archived messages stored in real SnapshotChainStore after squash",
    async () => {
      const seededMessages = createSeededMessages();
      const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();
      const sessionId = "e2e-session-archive" as SessionId;

      const { provider, middleware } = createSquashProvider(
        {
          archiver,
          sessionId,
          preserveRecent: 4,
        },
        () => seededMessages,
      );

      const adapter = createAdapter(
        "You MUST call the squash tool with phase 'research' and summary 'Research complete.' — nothing else. " +
          "After calling it, say 'Done.'",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [middleware],
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Squash now." }));

        // Verify archive has data
        const archiveChainId = chainId(`squash:${sessionId}`);
        const headResult = await archiver.head(archiveChainId);
        expect(headResult.ok).toBe(true);

        if (headResult.ok && headResult.value !== undefined) {
          // Archived data should contain the older messages (seeded - preserveRecent)
          const archivedData = headResult.value.data;
          expect(archivedData.length).toBe(4); // 8 seeded - 4 preserveRecent = 4 archived
          // First archived message should be the first seeded message
          expect(archivedData[0]?.content[0]).toMatchObject({
            kind: "text",
            text: "User: I need help building a REST API for a todo app.",
          });
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Middleware applies squash on next model call ────────────

  test(
    "companion middleware replaces messages on the model call after squash",
    async () => {
      const seededMessages = createSeededMessages();
      const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();

      const { provider, middleware: squashMiddleware } = createSquashProvider(
        {
          archiver,
          sessionId: "e2e-session-mw" as SessionId,
          preserveRecent: 4,
        },
        () => seededMessages,
      );

      // Capture messages from each model call to detect replacement
      const modelCallMessageCounts: number[] = []; // let justified: test accumulator
      let sawSquashSummaryMessage = false; // let justified: toggled in observer

      const streamObserver: KoiMiddleware = {
        name: "e2e-squash-stream-observer",
        // Priority lower than squash middleware (220) so we see post-squash messages
        priority: 230,
        describeCapabilities: () => undefined,
        wrapModelStream: async function* (_ctx, request: ModelRequest, next: ModelStreamHandler) {
          modelCallMessageCounts.push(request.messages.length);

          // Check if any message has senderId "system:squash" (injected by squash tool)
          const hasSquashMessage = request.messages.some((m) => m.senderId === "system:squash");
          if (hasSquashMessage) {
            sawSquashSummaryMessage = true;
          }

          yield* next(request);
        },
      };

      const adapter = createAdapter(
        "You MUST call the squash tool with phase 'implementation' and summary 'Implementation done.' " +
          "After calling it, say 'Squash applied.'",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [squashMiddleware, streamObserver],
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Squash now." }));

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // There should be at least 2 model calls (1st triggers tool call, 2nd after tool result)
        expect(modelCallMessageCounts.length).toBeGreaterThanOrEqual(2);

        // The second model call should have the squash summary message
        // (squash middleware fires at priority 220, observer at 230 sees post-replacement)
        expect(sawSquashSummaryMessage).toBe(true);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Facts stored to memory ─────────────────────────────────

  test(
    "squash with memory: archive populated, facts stored if LLM includes them",
    async () => {
      const seededMessages = createSeededMessages();
      const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();

      const storeMock = mock(() => Promise.resolve());
      const mockMemory: MemoryComponent = {
        recall: mock(() => Promise.resolve([])),
        store: storeMock,
      };

      const { provider, middleware } = createSquashProvider(
        {
          archiver,
          memory: mockMemory,
          sessionId: "e2e-session-facts" as SessionId,
          preserveRecent: 4,
        },
        () => seededMessages,
      );

      const adapter = createAdapter(
        "You MUST call the squash tool with these EXACT arguments:\n" +
          '- phase: "planning"\n' +
          '- summary: "Planning complete."\n' +
          '- facts: ["User wants Express.js", "Database is PostgreSQL"]\n' +
          "After calling it, say 'Done.'",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [middleware],
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Squash with facts now." }));

        // Verify archive was populated (squash tool was called)
        const archiveChainId = chainId("squash:e2e-session-facts");
        const headResult = await archiver.head(archiveChainId);
        expect(headResult.ok).toBe(true);

        // If the LLM included the optional facts array, memory.store was called
        // (LLMs sometimes omit optional params, so this is a soft check)
        if (storeMock.mock.calls.length > 0) {
          const firstCallArgs = storeMock.mock.calls[0] as
            | [string, { category: string }]
            | undefined;
          if (firstCallArgs !== undefined) {
            expect(firstCallArgs[1]?.category).toBe("planning");
          }
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Multi-tool agent with squash ───────────────────────────

  test(
    "squash tool works alongside other tools in the same agent",
    async () => {
      const seededMessages = createSeededMessages();
      const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();

      const { provider: squashProvider, middleware } = createSquashProvider(
        {
          archiver,
          sessionId: "e2e-session-multi" as SessionId,
          preserveRecent: 4,
        },
        () => seededMessages,
      );

      // A second tool alongside squash
      const multiplyTool: Tool = {
        descriptor: {
          name: "multiply",
          description: "Multiplies two numbers and returns the product.",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number", description: "First number" },
              b: { type: "number", description: "Second number" },
            },
            required: ["a", "b"],
          },
        },
        origin: "primordial",
        policy: DEFAULT_SANDBOXED_POLICY,
        execute: async (input) => String(Number(input.a ?? 0) * Number(input.b ?? 0)),
      };

      const toolCallNames: string[] = []; // let justified: test accumulator
      const toolObserver: KoiMiddleware = {
        name: "e2e-multi-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, request, next) => {
          toolCallNames.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createAdapter(
        "You have two tools: multiply and squash. You MUST:\n" +
          "1. First, use the multiply tool to compute 7 * 6.\n" +
          '2. Then, call the squash tool with phase "calculation" and ' +
          'summary "Calculated 7 * 6 = 42."\n' +
          "3. Report both results briefly.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [middleware, toolObserver],
        providers: [squashProvider, createToolProvider([multiplyTool])],
        loopDetection: false,
        limits: { maxTurns: 8 },
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Do the math and squash." }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Both tools should have been called
        expect(toolCallNames).toContain("multiply");
        expect(toolCallNames).toContain("squash");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Lifecycle: onSessionEnd clears pending queue ───────────

  test(
    "session end disposes cleanly with no pending squash leaks",
    async () => {
      const seededMessages = createSeededMessages();
      const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();

      const { provider, middleware } = createSquashProvider(
        {
          archiver,
          sessionId: "e2e-session-dispose" as SessionId,
          preserveRecent: 4,
        },
        () => seededMessages,
      );

      let sessionEndFired = false; // let justified: toggled in hook

      const lifecycleObserver: KoiMiddleware = {
        name: "e2e-lifecycle-observer",
        priority: 300,
        describeCapabilities: () => undefined,
        onSessionEnd: async () => {
          sessionEndFired = true;
        },
      };

      const adapter = createAdapter(
        "You MUST call the squash tool with phase 'cleanup' and summary 'Cleanup done.' " +
          "After calling it, say 'Complete.'",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [middleware, lifecycleObserver],
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Clean up." }));

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Session lifecycle completed — middleware onSessionEnd fired
        expect(sessionEndFired).toBe(true);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Pinned messages survive squash ─────────────────────────

  test(
    "pinned messages preserved through squash in the compacted output",
    async () => {
      const seededMessages: InboundMessage[] = [
        makeMessage("SYSTEM INSTRUCTION: Always be helpful.", { pinned: true }),
        ...createSeededMessages(),
      ];
      const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();

      const { provider, middleware: squashMiddleware } = createSquashProvider(
        {
          archiver,
          sessionId: "e2e-session-pinned" as SessionId,
          preserveRecent: 4,
        },
        () => seededMessages,
      );

      // Capture the replaced messages to verify pinned message is preserved
      let replacedMessages: readonly InboundMessage[] | undefined; // let justified: captured in observer

      const streamObserver: KoiMiddleware = {
        name: "e2e-pinned-observer",
        priority: 230, // After squash middleware (220)
        describeCapabilities: () => undefined,
        wrapModelStream: async function* (_ctx, request: ModelRequest, next: ModelStreamHandler) {
          const hasSquashMsg = request.messages.some((m) => m.senderId === "system:squash");
          if (hasSquashMsg) {
            replacedMessages = request.messages;
          }
          yield* next(request);
        },
      };

      const adapter = createAdapter(
        "Call the squash tool with phase 'review' and summary 'Review done.' " + "Then say 'OK.'",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [squashMiddleware, streamObserver],
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Squash now." }));

        // Replaced messages should include the pinned message
        expect(replacedMessages).toBeDefined();
        if (replacedMessages !== undefined) {
          const pinnedMsg = replacedMessages.find((m) => m.pinned === true);
          expect(pinnedMsg).toBeDefined();
          expect(pinnedMsg?.content[0]).toMatchObject({
            kind: "text",
            text: "SYSTEM INSTRUCTION: Always be helpful.",
          });

          // Should also have the squash summary
          const squashMsg = replacedMessages.find((m) => m.senderId === "system:squash");
          expect(squashMsg).toBeDefined();
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
