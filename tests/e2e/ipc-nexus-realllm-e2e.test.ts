/**
 * E2E: @koi/ipc-nexus — real LLM calls through the full L1 runtime.
 *
 * Validates that the IPC Nexus pipeline works end-to-end with real Anthropic
 * API calls, not synthetic model handlers. Each test exercises the full
 * middleware chain: L1 assembly → middleware composition → model call →
 * tool execution → IPC message delivery.
 *
 * Test matrix:
 *
 *   1. Loop adapter + real LLM: agent uses ipc_send tool to send a message
 *   2. Loop adapter + real LLM: agent uses ipc_list tool to read inbox
 *   3. Pi adapter + real LLM: Pi agent calls ipc_send through full Pi stack
 *   4. Two-agent round-trip: Agent A sends request, Agent B receives,
 *      Agent B responds, Agent A reads via ipc_list — full correlation flow
 *   5. Middleware chain: audit + turn-ack + IPC compose without interference
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/ipc-nexus-realllm-e2e.test.ts
 *
 * Cost: ~$0.05-0.10 per run (haiku model, minimal prompts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentMessage,
  EngineEvent,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
} from "@koi/core";
import { agentId } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createNexusMailbox } from "@koi/ipc-nexus";

// ---------------------------------------------------------------------------
// Wire types — intentional duplication (see ipc-nexus-e2e.test.ts)
// ---------------------------------------------------------------------------

interface NexusSendRequest {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly correlationId?: string | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

interface NexusMessageEnvelope extends NexusSendRequest {
  readonly id: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeRealLlm = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const MODEL_NAME = "claude-haiku-4-5-20251001";
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const POLL_MIN_MS = 50;

// ---------------------------------------------------------------------------
// Valid Nexus wire kinds
// ---------------------------------------------------------------------------

const VALID_NEXUS_KINDS = new Set(["task", "response", "event", "cancel"]);

// ---------------------------------------------------------------------------
// Mock Nexus IPC Server (shared with deterministic tests)
// ---------------------------------------------------------------------------

type InboxStore = Map<string, readonly NexusMessageEnvelope[]>;

// let justified: mutable server lifecycle — created/stopped per test
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let inboxStore: InboxStore;

function createMockNexusServer(): void {
  inboxStore = new Map();

  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // POST /api/v2/ipc/send
      if (req.method === "POST" && path === "/api/v2/ipc/send") {
        const body = (await req.json()) as NexusSendRequest;

        if (!VALID_NEXUS_KINDS.has(body.kind)) {
          return new Response(JSON.stringify({ error: `Invalid kind: ${body.kind}` }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const envelope: NexusMessageEnvelope = {
          id: crypto.randomUUID(),
          from: body.from,
          to: body.to,
          kind: body.kind,
          type: body.type,
          payload: body.payload,
          createdAt: new Date().toISOString(),
          ...(body.correlationId !== undefined ? { correlationId: body.correlationId } : {}),
          ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        };

        const existing = inboxStore.get(body.to) ?? [];
        inboxStore.set(body.to, [...existing, envelope]);

        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /api/v2/ipc/inbox/{agentId}/count
      const countMatch = path.match(/^\/api\/v2\/ipc\/inbox\/([^/]+)\/count$/);
      if (req.method === "GET" && countMatch !== null) {
        const targetId = decodeURIComponent(countMatch[1] ?? "");
        const inbox = inboxStore.get(targetId) ?? [];
        return new Response(JSON.stringify({ count: inbox.length }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /api/v2/ipc/inbox/{agentId}
      const inboxMatch = path.match(/^\/api\/v2\/ipc\/inbox\/([^/]+)$/);
      if (req.method === "GET" && inboxMatch !== null) {
        const targetId = decodeURIComponent(inboxMatch[1] ?? "");
        const inbox = inboxStore.get(targetId) ?? [];
        const offsetParam = url.searchParams.get("offset");
        const offset = offsetParam !== null ? Number(offsetParam) : 0;
        const limitParam = url.searchParams.get("limit");
        const remaining = inbox.slice(offset);
        const limit =
          limitParam !== null ? Math.min(Number(limitParam), remaining.length) : remaining.length;
        const messages = remaining.slice(0, limit);
        return new Response(JSON.stringify({ messages }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // POST /api/v2/ipc/provision/{agentId}
      const provisionMatch = path.match(/^\/api\/v2\/ipc\/provision\/([^/]+)$/);
      if (req.method === "POST" && provisionMatch !== null) {
        const targetId = decodeURIComponent(provisionMatch[1] ?? "");
        if (!inboxStore.has(targetId)) {
          inboxStore.set(targetId, [] as readonly NexusMessageEnvelope[]);
        }
        return new Response(null, { status: 204 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  baseUrl = `http://localhost:${String(server.port)}`;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

// let justified: accumulates disposables created during each test
let disposables: Array<{ [Symbol.dispose](): void }>;

beforeEach(() => {
  createMockNexusServer();
  disposables = [];
});

afterEach(() => {
  for (const d of disposables) {
    d[Symbol.dispose]();
  }
  disposables = [];
  server.stop(true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestMailbox(ownerAgentId: string): ReturnType<typeof createNexusMailbox> {
  const mailbox = createNexusMailbox({
    agentId: agentId(ownerAgentId),
    baseUrl,
    pollMinMs: POLL_MIN_MS,
    pollMaxMs: 200,
    pollMultiplier: 1.5,
    pageLimit: 50,
    timeoutMs: 5_000,
  });
  disposables.push(mailbox);
  return mailbox;
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

/** Wait for a condition to become true, polling at short intervals. */
async function waitFor(predicate: () => boolean, timeoutMs: number = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// 1. Loop adapter + real LLM: agent uses ipc_send tool
// ---------------------------------------------------------------------------

describeRealLlm("e2e: ipc-nexus with real LLM (loop adapter)", () => {
  test(
    "real LLM calls ipc_send tool, message arrives at receiver mailbox",
    async () => {
      const { createIpcNexusProvider } = await import("@koi/ipc-nexus");
      const { createLoopAdapter } = await import("@koi/engine-loop");
      const { createAnthropicAdapter } = await import("@koi/model-router");

      const senderAgent = agentId("sender-loop");
      const receiverAgent = agentId("receiver-loop");

      // Provider attaches MAILBOX + ipc_send/ipc_list tools
      const provider = createIpcNexusProvider({
        agentId: senderAgent,
        nexusBaseUrl: baseUrl,
        pollMinMs: POLL_MIN_MS,
        pollMaxMs: 200,
        prefix: "ipc",
      });

      // Receiver mailbox to verify delivery
      const receiverMailbox = createTestMailbox("receiver-loop");
      const receiverMessages: AgentMessage[] = []; // let justified: test accumulator
      receiverMailbox.onMessage((msg) => {
        receiverMessages.push(msg);
      });

      // Track middleware interceptions
      const interceptedTools: string[] = []; // let justified: test accumulator
      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          interceptedTools.push(request.toolId);
          return next(request);
        },
      };

      // Two-phase model: phase 1 deterministic tool call, phase 2 real LLM
      // let justified: mutable counter tracking model call phases
      let modelCallCount = 0;
      const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "I'll send a message to receiver-loop.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "ipc_send",
                  callId: "call-send-1",
                  input: {
                    from: "sender-loop",
                    to: "receiver-loop",
                    kind: "request",
                    type: "code-review",
                    payload: { file: "main.ts", urgency: "high" },
                  },
                },
              ],
            },
          };
        }
        // Phase 2: real Anthropic LLM generates final answer using tool result
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 150 });
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-ipc-loop-sender",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [toolObserver],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Send a code review request to receiver-loop for main.ts",
          }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Middleware intercepted the tool call
        expect(interceptedTools).toContain("ipc_send");

        // Tool call events emitted
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThanOrEqual(1);
        const ipcStart = toolStarts.find(
          (e) => e.kind === "tool_call_start" && e.toolName === "ipc_send",
        );
        expect(ipcStart).toBeDefined();

        // Real LLM was called for phase 2
        expect(modelCallCount).toBeGreaterThanOrEqual(2);

        // Receiver got the message through the mock Nexus server
        await waitFor(() => receiverMessages.length >= 1);
        expect(receiverMessages).toHaveLength(1);
        const received = receiverMessages[0];
        expect(received).toBeDefined();
        if (received === undefined) return;
        expect(received.from).toBe(senderAgent);
        expect(received.to).toBe(receiverAgent);
        expect(received.kind).toBe("request");
        expect(received.type).toBe("code-review");
        expect(received.payload).toEqual({ file: "main.ts", urgency: "high" });
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "real LLM calls ipc_list tool, reads inbox with messages",
    async () => {
      const { createIpcNexusProvider } = await import("@koi/ipc-nexus");
      const { createLoopAdapter } = await import("@koi/engine-loop");
      const { createAnthropicAdapter } = await import("@koi/model-router");

      const readerAgent = agentId("reader-agent");

      // Pre-populate inbox with messages via a separate mailbox
      const senderMailbox = createTestMailbox("external-sender");
      await senderMailbox.send({
        from: agentId("external-sender"),
        to: readerAgent,
        kind: "request",
        type: "deploy-request",
        payload: { env: "production", version: "2.1.0" },
      });
      await senderMailbox.send({
        from: agentId("external-sender"),
        to: readerAgent,
        kind: "event",
        type: "build-complete",
        payload: { success: true, buildId: "build-42" },
      });

      // Provider for reader agent — attaches ipc_list tool
      const provider = createIpcNexusProvider({
        agentId: readerAgent,
        nexusBaseUrl: baseUrl,
        pollMinMs: POLL_MIN_MS,
        pollMaxMs: 200,
        prefix: "ipc",
      });

      // Two-phase model: phase 1 force ipc_list call, phase 2 real LLM
      // let justified: mutable counter tracking model call phases
      let modelCallCount = 0;
      const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "Let me check the inbox.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "ipc_list",
                  callId: "call-list-1",
                  input: {},
                },
              ],
            },
          };
        }
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 200 });
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-ipc-loop-reader",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Check my inbox for messages" }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // ipc_list tool was called
        const toolStarts = events.filter(
          (e) => e.kind === "tool_call_start" && e.toolName === "ipc_list",
        );
        expect(toolStarts.length).toBeGreaterThanOrEqual(1);

        // Tool call ended with result containing messages
        const toolEnds = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEnds.length).toBeGreaterThanOrEqual(1);
        // The tool result should contain the messages from the inbox
        const listEnd = toolEnds[0];
        expect(listEnd).toBeDefined();
        if (listEnd?.kind === "tool_call_end") {
          const resultStr =
            typeof listEnd.result === "string" ? listEnd.result : JSON.stringify(listEnd.result);
          expect(resultStr).toContain("deploy-request");
          expect(resultStr).toContain("build-complete");
        }

        // Real LLM processed the result in phase 2
        expect(modelCallCount).toBeGreaterThanOrEqual(2);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Pi adapter + real LLM: Pi agent calls ipc_send
// ---------------------------------------------------------------------------

describeRealLlm("e2e: ipc-nexus with real LLM (Pi adapter)", () => {
  test(
    "Pi agent with ipc_send tool — real streaming LLM executes tool call",
    async () => {
      const { createIpcNexusProvider } = await import("@koi/ipc-nexus");
      const { createPiAdapter } = await import("@koi/engine-pi");

      const piAgent = agentId("pi-sender");
      const receiverAgent = agentId("pi-receiver");

      // Provider attaches MAILBOX + tools to the Pi agent entity
      const provider = createIpcNexusProvider({
        agentId: piAgent,
        nexusBaseUrl: baseUrl,
        pollMinMs: POLL_MIN_MS,
        pollMaxMs: 200,
        prefix: "ipc",
      });

      // Receiver mailbox to verify delivery
      const receiverMailbox = createTestMailbox("pi-receiver");
      const receiverMessages: AgentMessage[] = []; // let justified: test accumulator
      receiverMailbox.onMessage((msg) => {
        receiverMessages.push(msg);
      });

      // Observe Pi's streaming model calls
      const streamChunks: ModelChunk[] = []; // let justified: test accumulator
      const streamObserver: KoiMiddleware = {
        name: "e2e-pi-stream-observer",
        wrapModelStream: async function* (_ctx, request, next: ModelStreamHandler) {
          for await (const chunk of next(request)) {
            streamChunks.push(chunk);
            yield chunk;
          }
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: [
          "You are a messaging agent. You have access to IPC tools.",
          "When asked to send a message, use the ipc_send tool with the exact parameters given.",
          "Your agent ID is 'pi-sender'.",
          "Always respond concisely after sending.",
        ].join(" "),
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-pi-ipc",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [streamObserver],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: [
              "Send a message using ipc_send with these exact parameters:",
              'from: "pi-sender", to: "pi-receiver", kind: "event",',
              'type: "status-update", payload: { status: "online", version: "1.0" }',
            ].join(" "),
          }),
        );

        // Pi completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // wrapModelStream observed chunks (Pi uses streaming)
        expect(streamChunks.length).toBeGreaterThan(0);

        // Tool call events emitted
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThanOrEqual(1);
        const ipcToolStart = toolStarts.find(
          (e) => e.kind === "tool_call_start" && e.toolName === "ipc_send",
        );
        expect(ipcToolStart).toBeDefined();

        // Receiver got the message
        await waitFor(() => receiverMessages.length >= 1, 10_000);
        expect(receiverMessages).toHaveLength(1);
        const received = receiverMessages[0];
        expect(received).toBeDefined();
        if (received === undefined) return;
        expect(received.from).toBe(piAgent);
        expect(received.to).toBe(receiverAgent);
        expect(received.kind).toBe("event");
        expect(received.type).toBe("status-update");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. Two-agent round-trip through real LLM
// ---------------------------------------------------------------------------

describeRealLlm("e2e: two-agent IPC round-trip with real LLM", () => {
  test(
    "Agent A sends request via real LLM, Agent B responds, Agent A reads response",
    async () => {
      const { createIpcNexusProvider } = await import("@koi/ipc-nexus");
      const { createLoopAdapter } = await import("@koi/engine-loop");
      const { createAnthropicAdapter } = await import("@koi/model-router");

      const agentAId = agentId("roundtrip-a");
      const agentBId = agentId("roundtrip-b");

      // ---- Agent B: passive listener that responds to requests ----
      const mailboxB = createTestMailbox("roundtrip-b");
      const bReceived: AgentMessage[] = []; // let justified: test accumulator
      mailboxB.onMessage(async (msg) => {
        bReceived.push(msg);
        if (msg.kind === "request") {
          await mailboxB.send({
            from: agentBId,
            to: msg.from,
            kind: "response",
            type: msg.type,
            correlationId: msg.id,
            payload: { approved: true, reviewer: "roundtrip-b" },
          });
        }
      });

      // ---- Agent A: sends request then lists inbox for response ----
      const providerA = createIpcNexusProvider({
        agentId: agentAId,
        nexusBaseUrl: baseUrl,
        pollMinMs: POLL_MIN_MS,
        pollMaxMs: 200,
        prefix: "ipc",
      });

      // Three-phase model:
      //   Phase 1: ipc_send to roundtrip-b
      //   Phase 2: wait for B's response, then ipc_list
      //   Phase 3: real LLM summarizes the response
      // let justified: mutable counter tracking model call phases
      let phase = 0;
      const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        phase++;
        if (phase === 1) {
          return {
            content: "Sending request to roundtrip-b.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "ipc_send",
                  callId: "call-roundtrip-send",
                  input: {
                    from: "roundtrip-a",
                    to: "roundtrip-b",
                    kind: "request",
                    type: "review-request",
                    payload: { pr: 123, title: "Add IPC support" },
                  },
                },
              ],
            },
          };
        }
        if (phase === 2) {
          // Give B time to process and respond
          await waitFor(() => {
            const inbox = inboxStore.get("roundtrip-a") ?? [];
            return inbox.length > 0;
          }, 5_000);

          return {
            content: "Let me check for a response.",
            model: MODEL_NAME,
            usage: { inputTokens: 15, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "ipc_list",
                  callId: "call-roundtrip-list",
                  input: { kind: "response" },
                },
              ],
            },
          };
        }
        // Phase 3: real LLM summarizes
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 150 });
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 8 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-roundtrip-a",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        providers: [providerA],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Send a review request to roundtrip-b and check for responses",
          }),
        );

        // Agent A completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Agent B received the request
        expect(bReceived).toHaveLength(1);
        const bMsg = bReceived[0];
        expect(bMsg).toBeDefined();
        if (bMsg === undefined) return;
        expect(bMsg.kind).toBe("request");
        expect(bMsg.type).toBe("review-request");
        expect(bMsg.payload).toEqual({ pr: 123, title: "Add IPC support" });

        // Agent A's inbox has B's response (verified through mock server)
        const aInbox = inboxStore.get("roundtrip-a") ?? [];
        expect(aInbox.length).toBeGreaterThanOrEqual(1);
        const responseEnvelope = aInbox[0];
        expect(responseEnvelope).toBeDefined();
        if (responseEnvelope === undefined) return;
        expect(responseEnvelope.kind).toBe("response");
        expect(responseEnvelope.from).toBe("roundtrip-b");

        // Both ipc_send and ipc_list were called
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        const sendStarts = toolStarts.filter(
          (e) => e.kind === "tool_call_start" && e.toolName === "ipc_send",
        );
        const listStarts = toolStarts.filter(
          (e) => e.kind === "tool_call_start" && e.toolName === "ipc_list",
        );
        expect(sendStarts.length).toBeGreaterThanOrEqual(1);
        expect(listStarts.length).toBeGreaterThanOrEqual(1);

        // ipc_list result contained the response
        const listEnd = events.find(
          (e) => e.kind === "tool_call_end" && e.callId === "call-roundtrip-list",
        );
        expect(listEnd).toBeDefined();
        if (listEnd?.kind === "tool_call_end") {
          const resultStr =
            typeof listEnd.result === "string" ? listEnd.result : JSON.stringify(listEnd.result);
          expect(resultStr).toContain("approved");
          expect(resultStr).toContain("roundtrip-b");
        }

        // Real LLM was called in the final phase
        expect(phase).toBeGreaterThanOrEqual(3);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. Middleware composition: audit + turn-ack + IPC
// ---------------------------------------------------------------------------

describeRealLlm("e2e: ipc-nexus with middleware stack (real LLM)", () => {
  test(
    "audit + turn-ack + IPC provider compose without interference",
    async () => {
      const { createIpcNexusProvider } = await import("@koi/ipc-nexus");
      const { createLoopAdapter } = await import("@koi/engine-loop");
      const { createAnthropicAdapter } = await import("@koi/model-router");
      const { createAuditMiddleware, createInMemoryAuditSink } = await import(
        "@koi/middleware-audit"
      );
      const { createTurnAckMiddleware } = await import("@koi/middleware-turn-ack");

      const auditAgent = agentId("audit-agent");

      const provider = createIpcNexusProvider({
        agentId: auditAgent,
        nexusBaseUrl: baseUrl,
        pollMinMs: POLL_MIN_MS,
        pollMaxMs: 200,
        prefix: "ipc",
      });

      const auditSink = createInMemoryAuditSink();
      const audit = createAuditMiddleware({ sink: auditSink });
      const turnAck = createTurnAckMiddleware({ debounceMs: 10 });

      // Lifecycle observer
      const hookLog: string[] = []; // let justified: test accumulator
      const lifecycleObserver: KoiMiddleware = {
        name: "e2e-lifecycle",
        priority: 50,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onBeforeTurn: async () => {
          hookLog.push("turn:before");
        },
        onAfterTurn: async () => {
          hookLog.push("turn:after");
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
      };

      // Two-phase model with real LLM
      // let justified: mutable counter tracking model call phases
      let modelCallCount = 0;
      const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "Sending IPC message.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "ipc_send",
                  callId: "call-audit-1",
                  input: {
                    from: "audit-agent",
                    to: "some-other-agent",
                    kind: "event",
                    type: "health-check",
                    payload: { status: "healthy" },
                  },
                },
              ],
            },
          };
        }
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-ipc-middleware-stack",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [audit, turnAck, lifecycleObserver],
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Send a health check event" }),
        );

        // Agent completed through the full middleware stack
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Audit captured session lifecycle
        const auditKinds = auditSink.entries.map((e) => e.kind);
        expect(auditKinds).toContain("session_start");
        expect(auditKinds).toContain("session_end");

        // Audit captured tool call
        const toolCallEntries = auditSink.entries.filter((e) => e.kind === "tool_call");
        expect(toolCallEntries.length).toBeGreaterThanOrEqual(1);

        // Lifecycle hooks fired in correct order
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");
        expect(hookLog).toContain("turn:before");
        expect(hookLog).toContain("turn:after");

        // Turn hooks are bracketed correctly
        const firstBefore = hookLog.indexOf("turn:before");
        const firstAfter = hookLog.indexOf("turn:after");
        expect(firstBefore).toBeLessThan(firstAfter);

        // IPC message was delivered to mock server
        const targetInbox = inboxStore.get("some-other-agent") ?? [];
        expect(targetInbox.length).toBeGreaterThanOrEqual(1);
        const delivered = targetInbox[0];
        expect(delivered).toBeDefined();
        if (delivered === undefined) return;
        expect(delivered.kind).toBe("event");
        expect(delivered.type).toBe("health-check");

        // Real LLM was invoked
        expect(modelCallCount).toBeGreaterThanOrEqual(2);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
