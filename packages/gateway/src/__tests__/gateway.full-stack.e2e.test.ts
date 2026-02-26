/**
 * Full-stack E2E test: Gateway + createKoi + createPiAdapter + real LLM.
 *
 * Validates that gateway features (connection lifecycle, frame dispatch,
 * session resume, channel binding) work end-to-end with a real Koi runtime
 * and live Anthropic API calls.
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/gateway.full-stack.e2e.test.ts
 *
 * Or with .env at repo root:
 *   bun test --env-file=../../.env src/__tests__/gateway.full-stack.e2e.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentManifest, EngineEvent, KoiMiddleware } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { BunTransport } from "../transport.js";
import { createBunTransport } from "../transport.js";
import type { ConnectFrame, GatewayFrame, Session } from "../types.js";
import { createConnectMessage, createResumeConnectMessage } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

const MANIFEST: AgentManifest = {
  name: "gateway-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a real WebSocket to the gateway and collect messages. */
function connectClient(port: number): {
  ws: WebSocket;
  messages: string[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
} {
  const messages: string[] = [];

  // let justified: deferred promise resolve, set in constructor callback
  let resolveOpened: () => void;
  const opened = new Promise<void>((r) => {
    resolveOpened = r;
  });

  // let justified: deferred promise resolve, set in constructor callback
  let resolveClosed: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => {
    resolveClosed = r;
  });

  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.addEventListener("open", () => resolveOpened());
  ws.addEventListener("message", (e) => messages.push(String(e.data)));
  ws.addEventListener("close", (e) => resolveClosed({ code: e.code, reason: e.reason }));

  return { ws, messages, opened, closed };
}

/** Wait until the messages array has at least `count` entries (with timeout). */
async function waitForMessages(
  messages: readonly string[],
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (messages.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} messages (got ${messages.length})`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Collect all events from an async iterable. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Extract concatenated text from text_delta events. */
function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("full-stack e2e: Gateway + createKoi + Pi adapter + real LLM", () => {
  // let justified: assigned in each test, cleaned up in afterEach
  let transport: BunTransport;
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.stop();
  });

  test(
    "gateway dispatches frame to Koi runtime, receives real LLM response",
    async () => {
      transport = createBunTransport();
      const auth = {
        async authenticate(_frame: ConnectFrame) {
          return {
            ok: true as const,
            sessionId: "e2e-llm-session",
            agentId: "e2e-agent",
            metadata: {},
          };
        },
        async validate() {
          return true;
        },
      };

      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      // Wire frame dispatch: gateway -> createKoi -> real LLM -> gateway.send()
      gateway.onFrame(async (session: Session, frame: GatewayFrame) => {
        const text =
          typeof frame.payload === "object" &&
          frame.payload !== null &&
          "text" in frame.payload &&
          typeof (frame.payload as Record<string, unknown>).text === "string"
            ? (frame.payload as Record<string, unknown>).text
            : "Say hello";

        const piAdapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "You are a concise test assistant. Reply with the minimum words possible.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: MANIFEST,
          adapter: piAdapter,
          loopDetection: false,
          limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: text as string }));

        const responseText = extractText(events);
        await runtime.dispose();

        // Send the LLM response back through the gateway
        gateway.send(session.id, {
          kind: "event",
          id: `resp-${frame.id}`,
          seq: 0,
          timestamp: Date.now(),
          payload: { response: responseText },
        });
      });

      const port = transport.port();
      const { ws, messages, opened } = connectClient(port);
      await opened;

      // Authenticate
      ws.send(createConnectMessage("e2e-token"));
      await waitForMessages(messages, 1);

      const authAck = JSON.parse(messages[0] as string) as Record<string, unknown>;
      expect(authAck.kind).toBe("ack");

      // Send a request frame with a prompt
      ws.send(
        JSON.stringify({
          kind: "request",
          id: "llm-req-1",
          seq: 0,
          timestamp: Date.now(),
          payload: { text: "What is 1 + 1? Reply with just the number." },
        }),
      );

      // Wait for ack + LLM response
      await waitForMessages(messages, 3, 30_000);

      const reqAck = JSON.parse(messages[1] as string) as Record<string, unknown>;
      expect(reqAck.kind).toBe("ack");
      expect(reqAck.ref).toBe("llm-req-1");

      const llmResponse = JSON.parse(messages[2] as string) as {
        kind: string;
        payload: { response: string };
      };
      expect(llmResponse.kind).toBe("event");
      expect(llmResponse.payload.response).toContain("2");

      ws.close();
    },
    TIMEOUT_MS,
  );

  test(
    "session resume preserves gateway state across disconnect",
    async () => {
      transport = createBunTransport();
      const auth = {
        async authenticate(_frame: ConnectFrame) {
          return {
            ok: true as const,
            sessionId: "resume-e2e-session",
            agentId: "resume-agent",
            metadata: {},
          };
        },
        async validate() {
          return true;
        },
      };

      // Enable session TTL for resume
      gateway = createGateway({ sessionTtlMs: 30_000 }, { transport, auth });
      await gateway.start(0);

      const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];
      gateway.onFrame((session, frame) => {
        dispatched.push({ session, frame });
      });

      const port = transport.port();

      // --- First connection ---
      const client1 = connectClient(port);
      await client1.opened;
      client1.ws.send(createConnectMessage("e2e-token"));
      await waitForMessages(client1.messages, 1);

      // Send a frame
      client1.ws.send(
        JSON.stringify({
          kind: "request",
          id: "pre-disconnect-1",
          seq: 0,
          timestamp: Date.now(),
          payload: { text: "before disconnect" },
        }),
      );
      await waitForMessages(client1.messages, 2);
      expect(dispatched).toHaveLength(1);

      // Disconnect
      client1.ws.close();
      await client1.closed;
      // Allow server-side cleanup to complete (move session to disconnected map)
      await new Promise((r) => setTimeout(r, 100));

      // Server pushes a frame while client is disconnected (buffered)
      const pushResult = gateway.send("resume-e2e-session", {
        kind: "event",
        id: "buffered-evt-1",
        seq: 0,
        timestamp: Date.now(),
        payload: { buffered: true },
      });
      // Should buffer successfully (session alive during TTL)
      expect(pushResult.ok).toBe(true);

      // --- Reconnect with resume ---
      const client2 = connectClient(port);
      await client2.opened;
      client2.ws.send(createResumeConnectMessage("resume-e2e-session", 0));
      await waitForMessages(client2.messages, 1);

      const resumeAck = JSON.parse(client2.messages[0] as string) as Record<string, unknown>;
      expect(resumeAck.kind).toBe("ack");

      // Buffered frame should have been replayed
      await waitForMessages(client2.messages, 2, 5_000);
      const replayedFrame = JSON.parse(client2.messages[1] as string) as {
        kind: string;
        payload: { buffered: boolean };
      };
      expect(replayedFrame.kind).toBe("event");
      expect(replayedFrame.payload.buffered).toBe(true);

      // Send another frame on the resumed session
      client2.ws.send(
        JSON.stringify({
          kind: "request",
          id: "post-resume-1",
          seq: 1,
          timestamp: Date.now(),
          payload: { text: "after resume" },
        }),
      );
      await waitForMessages(client2.messages, 3);

      // Should have dispatched both frames (pre-disconnect + post-resume)
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]?.frame.id).toBe("post-resume-1");

      client2.ws.close();
    },
    TIMEOUT_MS,
  );

  test(
    "channel binding routes frames to correct agent via real LLM",
    async () => {
      transport = createBunTransport();

      // let justified: tracks which agentId was assigned per session
      let sessionCounter = 0;
      const auth = {
        async authenticate(_frame: ConnectFrame) {
          sessionCounter++;
          return {
            ok: true as const,
            sessionId: `chan-session-${sessionCounter}`,
            agentId: "default-agent",
            metadata: {},
          };
        },
        async validate() {
          return true;
        },
      };

      // Static channel binding: "telegram" -> "telegram-handler"
      gateway = createGateway(
        {
          channelBindings: [{ channelName: "telegram", agentId: "telegram-handler" }],
          routing: {
            scopingMode: "per-channel-peer",
            bindings: [{ pattern: "slack:*", agentId: "slack-handler" }],
          },
        },
        { transport, auth },
      );
      await gateway.start(0);

      const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];
      gateway.onFrame((session, frame) => {
        dispatched.push({ session, frame });
      });

      // Dynamic binding at runtime
      gateway.bindChannel("slack", "slack-bot-agent");

      // Verify channel bindings are set
      const bindings = gateway.channelBindings();
      expect(bindings.get("telegram")).toBe("telegram-handler");
      expect(bindings.get("slack")).toBe("slack-bot-agent");

      // Connect client and send a frame
      const port = transport.port();
      const { ws, messages, opened } = connectClient(port);
      await opened;
      ws.send(createConnectMessage("e2e-token"));
      await waitForMessages(messages, 1);

      ws.send(
        JSON.stringify({
          kind: "request",
          id: "chan-req-1",
          seq: 0,
          timestamp: Date.now(),
          payload: { channel: "telegram" },
        }),
      );
      await waitForMessages(messages, 2);

      expect(dispatched).toHaveLength(1);

      // Unbind and verify
      const unbound = gateway.unbindChannel("slack");
      expect(unbound).toBe(true);
      expect(gateway.channelBindings().has("slack")).toBe(false);

      ws.close();
    },
    TIMEOUT_MS,
  );

  test(
    "session events emitted during full lifecycle with real LLM dispatch",
    async () => {
      transport = createBunTransport();
      const auth = {
        async authenticate(_frame: ConnectFrame) {
          return {
            ok: true as const,
            sessionId: "evt-e2e-session",
            agentId: "evt-agent",
            metadata: {},
          };
        },
        async validate() {
          return true;
        },
      };

      gateway = createGateway({ sessionTtlMs: 5_000 }, { transport, auth });
      await gateway.start(0);

      const sessionEvents: Array<{ kind: string }> = [];
      gateway.onSessionEvent((event) => {
        sessionEvents.push({ kind: event.kind });
      });

      // Wire frame dispatch to real LLM
      gateway.onFrame(async (session: Session, frame: GatewayFrame) => {
        const piAdapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "Reply with exactly one word.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: MANIFEST,
          adapter: piAdapter,
          loopDetection: false,
          limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 1_000 },
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Say: alive" }));
        const responseText = extractText(events);
        await runtime.dispose();

        gateway.send(session.id, {
          kind: "event",
          id: `resp-${frame.id}`,
          seq: 0,
          timestamp: Date.now(),
          payload: { response: responseText },
        });
      });

      const port = transport.port();
      const { ws, messages, opened } = connectClient(port);
      await opened;

      ws.send(createConnectMessage("e2e-token"));
      await waitForMessages(messages, 1);

      // Session created event should have fired
      expect(sessionEvents.some((e) => e.kind === "created")).toBe(true);

      // Send request and wait for LLM response
      ws.send(
        JSON.stringify({
          kind: "request",
          id: "evt-req-1",
          seq: 0,
          timestamp: Date.now(),
          payload: { text: "alive" },
        }),
      );
      await waitForMessages(messages, 3, 30_000);

      const llmResponse = JSON.parse(messages[2] as string) as {
        kind: string;
        payload: { response: string };
      };
      expect(llmResponse.kind).toBe("event");
      expect(llmResponse.payload.response.length).toBeGreaterThan(0);

      // Destroy session explicitly
      const destroyResult = gateway.destroySession("evt-e2e-session", "test cleanup");
      expect(destroyResult.ok).toBe(true);
      expect(sessionEvents.some((e) => e.kind === "destroyed")).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "middleware chain intercepts LLM call through gateway dispatch",
    async () => {
      transport = createBunTransport();
      const auth = {
        async authenticate(_frame: ConnectFrame) {
          return {
            ok: true as const,
            sessionId: "mw-e2e-session",
            agentId: "mw-agent",
            metadata: {},
          };
        },
        async validate() {
          return true;
        },
      };

      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      // let justified: tracks middleware interception
      let middlewareIntercepted = false;

      gateway.onFrame(async (session: Session, frame: GatewayFrame) => {
        const piAdapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "Reply with exactly one word: intercepted",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const observerMiddleware: KoiMiddleware = {
          name: "e2e:observer",
          priority: 500,
          async *wrapModelStream(_ctx, req, next) {
            middlewareIntercepted = true;
            yield* next(req);
          },
        };

        const runtime = await createKoi({
          manifest: MANIFEST,
          adapter: piAdapter,
          middleware: [observerMiddleware],
          loopDetection: false,
          limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 1_000 },
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Say: intercepted" }));
        const responseText = extractText(events);
        await runtime.dispose();

        gateway.send(session.id, {
          kind: "event",
          id: `resp-${frame.id}`,
          seq: 0,
          timestamp: Date.now(),
          payload: { response: responseText },
        });
      });

      const port = transport.port();
      const { ws, messages, opened } = connectClient(port);
      await opened;

      ws.send(createConnectMessage("e2e-token"));
      await waitForMessages(messages, 1);

      ws.send(
        JSON.stringify({
          kind: "request",
          id: "mw-req-1",
          seq: 0,
          timestamp: Date.now(),
          payload: { text: "intercepted" },
        }),
      );

      await waitForMessages(messages, 3, 30_000);

      // Middleware was hit
      expect(middlewareIntercepted).toBe(true);

      const llmResponse = JSON.parse(messages[2] as string) as {
        kind: string;
        payload: { response: string };
      };
      expect(llmResponse.kind).toBe("event");
      expect(llmResponse.payload.response.toLowerCase()).toContain("intercepted");

      ws.close();
    },
    TIMEOUT_MS,
  );
});
