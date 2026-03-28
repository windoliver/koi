/**
 * E2E: @koi/ipc-nexus — agent-to-agent messaging through a mock Nexus server.
 *
 * Validates the Nexus REST API contract by building a mock server that
 * implements all 4 endpoints, then exercises the full mailbox pipeline:
 *
 *   Suite 1 — Direct mailbox adapter (createNexusMailbox):
 *     1. Agent A sends, Agent B receives via onMessage
 *     2. Request-response correlation flow
 *     3. Event messages (fire-and-forget)
 *     4. list() returns filtered inbox
 *     5. Deduplication — same message not delivered twice
 *     6. Multiple handlers receive same message
 *     7. Handler errors don't crash polling
 *     8. Server error → send returns error Result
 *
 *   Suite 2 — Full assembly (createKoi + createLoopAdapter):
 *     9. Provider attaches MAILBOX + tools, agent sends via ipc_send tool
 *
 * All tests are fully deterministic — no LLM API key required.
 *
 * Run:
 *   bun test tests/e2e/ipc-nexus-e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage, EngineEvent, ModelRequest, ModelResponse } from "@koi/core";
import { agentId } from "@koi/core";
import { createNexusMailbox } from "@koi/ipc-nexus";

// ---------------------------------------------------------------------------
// Wire types — intentional duplication of nexus-client.ts types.
// The mock server defines its own wire types so that contract drift between
// the test's mock and the real Nexus API surface is caught independently.
// ---------------------------------------------------------------------------

interface NexusSendRequest {
  readonly sender: string;
  readonly recipient: string;
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
// Mock Nexus IPC Server
// ---------------------------------------------------------------------------

/** Valid Nexus wire kinds — validates that mapKoiToNexus produces correct values. */
const VALID_NEXUS_KINDS = new Set(["task", "response", "event", "cancel"]);

/** In-memory inbox store keyed by recipient agent ID. */
type InboxStore = Map<string, readonly NexusMessageEnvelope[]>;

// let justified: mutable server lifecycle — created/stopped per test
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let inboxStore: InboxStore;
// let justified: toggled per-test to simulate server errors
let forceServerError: boolean;

function createMockNexusServer(): void {
  inboxStore = new Map();
  forceServerError = false;

  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      if (forceServerError) {
        return new Response("Internal Server Error", { status: 500 });
      }

      const url = new URL(req.url);
      const path = url.pathname;

      // POST /api/v2/ipc/send
      if (req.method === "POST" && path === "/api/v2/ipc/send") {
        const body = (await req.json()) as NexusSendRequest;

        // Validate Nexus wire kind — catches mapKoiToNexus contract drift
        if (!VALID_NEXUS_KINDS.has(body.kind)) {
          return new Response(JSON.stringify({ error: `Invalid kind: ${body.kind}` }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const envelope: NexusMessageEnvelope = {
          id: crypto.randomUUID(),
          sender: body.sender,
          recipient: body.recipient,
          kind: body.kind,
          type: body.type,
          payload: body.payload,
          createdAt: new Date().toISOString(),
          ...(body.correlationId !== undefined ? { correlationId: body.correlationId } : {}),
          ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        };

        // Store in recipient's inbox (immutable — replace array)
        const existing = inboxStore.get(body.recipient) ?? [];
        inboxStore.set(body.recipient, [...existing, envelope]);

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

const POLL_MIN_MS = 50;
const TEST_TIMEOUT_MS = 10_000;

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
// Suite 1: Direct mailbox adapter against mock server
// ---------------------------------------------------------------------------

describe("e2e: ipc-nexus mailbox adapter against mock server", () => {
  test(
    "Agent A sends request, Agent B receives via onMessage",
    async () => {
      const mailboxA = createTestMailbox("agent-a");
      const mailboxB = createTestMailbox("agent-b");

      const received: AgentMessage[] = []; // let justified: test accumulator
      mailboxB.onMessage((msg) => {
        received.push(msg);
      });

      const result = await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "request",
        type: "code-review",
        payload: { file: "main.ts", lines: [1, 50] },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.from).toBe(agentId("agent-a"));
      expect(result.value.to).toBe(agentId("agent-b"));
      expect(result.value.kind).toBe("request");
      expect(result.value.type).toBe("code-review");

      await waitFor(() => received.length >= 1);

      expect(received).toHaveLength(1);
      const msg = received[0];
      expect(msg).toBeDefined();
      if (msg === undefined) return;
      expect(msg.from).toBe(agentId("agent-a"));
      expect(msg.to).toBe(agentId("agent-b"));
      expect(msg.kind).toBe("request");
      expect(msg.type).toBe("code-review");
      expect(msg.payload).toEqual({ file: "main.ts", lines: [1, 50] });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Request-response correlation flow",
    async () => {
      const mailboxA = createTestMailbox("agent-a");
      const mailboxB = createTestMailbox("agent-b");

      // Agent B listens and responds to requests
      const bReceived: AgentMessage[] = []; // let justified: test accumulator
      mailboxB.onMessage(async (msg) => {
        bReceived.push(msg);
        if (msg.kind === "request") {
          await mailboxB.send({
            from: agentId("agent-b"),
            to: msg.from,
            kind: "response",
            type: msg.type,
            correlationId: msg.id,
            payload: { status: "approved", reviewer: "agent-b" },
          });
        }
      });

      // Agent A sends a request
      const sendResult = await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "request",
        type: "review-request",
        payload: { pr: 42 },
      });
      expect(sendResult.ok).toBe(true);
      if (!sendResult.ok) return;

      const requestId = sendResult.value.id;

      // Agent A listens for the response
      const aReceived: AgentMessage[] = []; // let justified: test accumulator
      mailboxA.onMessage((msg) => {
        aReceived.push(msg);
      });

      // Wait for B to receive and respond, then A to receive the response
      await waitFor(() => aReceived.length >= 1);

      expect(aReceived).toHaveLength(1);
      const response = aReceived[0];
      expect(response).toBeDefined();
      if (response === undefined) return;
      expect(response.kind).toBe("response");
      expect(response.from).toBe(agentId("agent-b"));
      expect(response.correlationId).toBe(requestId);
      expect(response.payload).toEqual({ status: "approved", reviewer: "agent-b" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Event messages (fire-and-forget)",
    async () => {
      const mailboxA = createTestMailbox("agent-a");
      const mailboxB = createTestMailbox("agent-b");

      const received: AgentMessage[] = []; // let justified: test accumulator
      mailboxB.onMessage((msg) => {
        received.push(msg);
      });

      const result = await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "event",
        type: "build-complete",
        payload: { buildId: "abc123", success: true },
        metadata: { source: "ci" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The wire kind for "event" stays "event" (mapped 1:1)
      expect(result.value.kind).toBe("event");

      await waitFor(() => received.length >= 1);

      const msg = received[0];
      expect(msg).toBeDefined();
      if (msg === undefined) return;
      expect(msg.kind).toBe("event");
      expect(msg.type).toBe("build-complete");
      expect(msg.payload).toEqual({ buildId: "abc123", success: true });
      expect(msg.metadata).toEqual({ source: "ci" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "list() returns filtered inbox",
    async () => {
      const mailboxA = createTestMailbox("agent-a");
      const mailboxB = createTestMailbox("agent-b");
      const mailboxC = createTestMailbox("agent-c");

      // Send multiple messages to agent-b from different senders
      await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "request",
        type: "code-review",
        payload: { file: "a.ts" },
      });
      await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "event",
        type: "build-complete",
        payload: { success: true },
      });
      await mailboxC.send({
        from: agentId("agent-c"),
        to: agentId("agent-b"),
        kind: "request",
        type: "deploy-request",
        payload: { env: "staging" },
      });

      // No filter — get all
      const all = await mailboxB.list();
      expect(all).toHaveLength(3);

      // Filter by kind
      const requests = await mailboxB.list({ kind: "request" });
      expect(requests).toHaveLength(2);
      for (const msg of requests) {
        expect(msg.kind).toBe("request");
      }

      // Filter by type
      const reviews = await mailboxB.list({ type: "code-review" });
      expect(reviews).toHaveLength(1);
      const review = reviews[0];
      expect(review).toBeDefined();
      if (review === undefined) return;
      expect(review.type).toBe("code-review");

      // Filter by from
      const fromC = await mailboxB.list({ from: agentId("agent-c") });
      expect(fromC).toHaveLength(1);
      const fromCMsg = fromC[0];
      expect(fromCMsg).toBeDefined();
      if (fromCMsg === undefined) return;
      expect(fromCMsg.from).toBe(agentId("agent-c"));

      // Filter with limit
      const limited = await mailboxB.list({ limit: 1 });
      expect(limited).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Deduplication — same message not delivered twice",
    async () => {
      const mailboxA = createTestMailbox("agent-a");
      const mailboxB = createTestMailbox("agent-b");

      const received: AgentMessage[] = []; // let justified: test accumulator
      mailboxB.onMessage((msg) => {
        received.push(msg);
      });

      await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "request",
        type: "ping",
        payload: { seq: 1 },
      });

      await waitFor(() => received.length >= 1);

      // Wait for 3 more poll cycles — message should not arrive again
      await new Promise((resolve) => setTimeout(resolve, POLL_MIN_MS * 4));

      expect(received).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Multiple handlers receive same message",
    async () => {
      const mailboxA = createTestMailbox("agent-a");
      const mailboxB = createTestMailbox("agent-b");

      const handler1Received: AgentMessage[] = []; // let justified: test accumulator
      const handler2Received: AgentMessage[] = []; // let justified: test accumulator

      mailboxB.onMessage((msg) => {
        handler1Received.push(msg);
      });
      mailboxB.onMessage((msg) => {
        handler2Received.push(msg);
      });

      await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "event",
        type: "notify",
        payload: { text: "hello" },
      });

      await waitFor(() => handler1Received.length >= 1 && handler2Received.length >= 1);

      expect(handler1Received).toHaveLength(1);
      expect(handler2Received).toHaveLength(1);
      const h1Msg = handler1Received[0];
      const h2Msg = handler2Received[0];
      expect(h1Msg).toBeDefined();
      expect(h2Msg).toBeDefined();
      if (h1Msg === undefined || h2Msg === undefined) return;
      expect(h1Msg.id).toBe(h2Msg.id);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Handler errors don't crash polling",
    async () => {
      const mailboxA = createTestMailbox("agent-a");
      const mailboxB = createTestMailbox("agent-b");

      const successReceived: AgentMessage[] = []; // let justified: test accumulator

      // First handler throws
      mailboxB.onMessage(() => {
        throw new Error("handler exploded");
      });

      // Second handler should still receive
      mailboxB.onMessage((msg) => {
        successReceived.push(msg);
      });

      await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "event",
        type: "test",
        payload: { seq: 1 },
      });

      await waitFor(() => successReceived.length >= 1);
      expect(successReceived).toHaveLength(1);

      // Send a second message to prove polling didn't stop
      await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "event",
        type: "test",
        payload: { seq: 2 },
      });

      await waitFor(() => successReceived.length >= 2);
      expect(successReceived).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Server error → send returns error Result",
    async () => {
      const mailboxA = createTestMailbox("agent-a");

      // Force the server to return 500
      forceServerError = true;

      const result = await mailboxA.send({
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "request",
        type: "ping",
        payload: {},
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Suite 2: Full assembly with createKoi + createLoopAdapter
// ---------------------------------------------------------------------------

describe("e2e: ipc-nexus provider through createKoi + createLoopAdapter", () => {
  test(
    "createIpcNexusProvider attaches MAILBOX + tools, agent sends via ipc_send tool",
    async () => {
      const { createIpcNexusProvider } = await import("@koi/ipc-nexus");
      const { createLoopAdapter } = await import("@koi/engine-loop");
      const { createKoi } = await import("@koi/engine");

      const senderAgentId = agentId("sender-agent");
      const receiverAgentId = agentId("receiver-agent");

      // Create provider for sender agent
      const provider = createIpcNexusProvider({
        agentId: senderAgentId,
        nexusBaseUrl: baseUrl,
        pollMinMs: POLL_MIN_MS,
        pollMaxMs: 200,
        prefix: "ipc",
      });

      // Create a receiver mailbox to verify message arrives
      const receiverMailbox = createTestMailbox("receiver-agent");
      const receiverMessages: AgentMessage[] = []; // let justified: test accumulator
      receiverMailbox.onMessage((msg) => {
        receiverMessages.push(msg);
      });

      // Synthetic model call: first call returns ipc_send tool call, second ends turn
      // let justified: mutable counter tracking model call phases
      let modelCallCount = 0;
      const modelCall = async (_request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "Sending IPC message.",
            model: "synthetic",
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "ipc_send",
                  callId: "call-ipc-1",
                  input: {
                    from: "sender-agent",
                    to: "receiver-agent",
                    kind: "request",
                    type: "task-assignment",
                    payload: { task: "review PR #99" },
                  },
                },
              ],
            },
          };
        }
        // Second call: end the turn
        return {
          content: "Message sent successfully.",
          model: "synthetic",
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "ipc-e2e-sender",
          version: "0.0.1",
          model: { name: "synthetic" },
        },
        adapter,
        providers: [provider],
      });

      try {
        const events: EngineEvent[] = []; // let justified: test accumulator
        for await (const event of runtime.run({
          kind: "text",
          text: "Send a message to receiver-agent",
        })) {
          events.push(event);
        }

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // Tool call events were emitted
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThanOrEqual(1);
        const ipcStart = toolStarts.find(
          (e) => e.kind === "tool_call_start" && e.toolName === "ipc_send",
        );
        expect(ipcStart).toBeDefined();

        // Tool call ended successfully
        const toolEnds = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEnds.length).toBeGreaterThanOrEqual(1);

        // Receiver got the message through the mock server
        await waitFor(() => receiverMessages.length >= 1);
        expect(receiverMessages).toHaveLength(1);
        const received = receiverMessages[0];
        expect(received).toBeDefined();
        if (received === undefined) return;
        expect(received.from).toBe(senderAgentId);
        expect(received.to).toBe(receiverAgentId);
        expect(received.kind).toBe("request");
        expect(received.type).toBe("task-assignment");
        expect(received.payload).toEqual({ task: "review PR #99" });
      } finally {
        await runtime.dispose();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
