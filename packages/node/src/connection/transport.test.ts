/**
 * Unit tests for the WebSocket transport layer.
 *
 * Tests state machine transitions, frame queueing, and event emission.
 * Uses a real Bun WS server to test actual WebSocket behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { AuthConfig, NodeEvent, NodeFrame } from "../types.js";
import { signChallenge } from "./auth.js";
import { createTransport } from "./transport.js";

// ---------------------------------------------------------------------------
// Minimal WS server helper
// ---------------------------------------------------------------------------

interface MiniServer {
  readonly url: string;
  readonly close: () => void;
  readonly clients: ServerWebSocket<unknown>[];
  readonly received: string[];
}

function startServer(): MiniServer {
  const clients: ServerWebSocket<unknown>[] = [];
  const received: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      server.upgrade(req);
      return undefined;
    },
    websocket: {
      open(ws) {
        clients.push(ws);
      },
      message(_ws, msg) {
        received.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      },
      close(ws) {
        const idx = clients.indexOf(ws);
        if (idx >= 0) clients.splice(idx, 1);
      },
    },
  });

  return {
    url: `ws://localhost:${server.port}`,
    close() {
      for (const c of [...clients]) c.close(1000);
      clients.length = 0;
      server.stop(true);
    },
    clients,
    received,
  };
}

const defaultGatewayConfig = {
  url: "",
  reconnectBaseDelay: 100,
  reconnectMaxDelay: 500,
  reconnectMultiplier: 2,
  reconnectJitter: 0,
  maxRetries: 3,
};

const defaultHeartbeatConfig = {
  interval: 60_000,
  timeout: 5_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transport", () => {
  let server: MiniServer;

  beforeEach(() => {
    server = startServer();
  });

  afterEach(() => {
    server.close();
  });

  describe("state machine", () => {
    it("starts disconnected", () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );
      expect(transport.state()).toBe("disconnected");
    });

    it("transitions to connected after connect()", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );
      await transport.connect();
      expect(transport.state()).toBe("connected");
      await transport.close();
    });

    it("transitions to closed after close()", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );
      await transport.connect();
      await transport.close();
      expect(transport.state()).toBe("closed");
    });

    it("connect() is idempotent when already connected", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );
      await transport.connect();
      await transport.connect(); // no-op
      expect(transport.state()).toBe("connected");
      await transport.close();
    });
  });

  describe("frame sending", () => {
    const testFrame: NodeFrame = {
      nodeId: "node-1",
      agentId: "agent-1",
      correlationId: "corr-1",
      type: "agent:message",
      payload: { text: "hello" },
    };

    it("sends frames when connected", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );
      await transport.connect();

      transport.send(testFrame);
      await new Promise((r) => setTimeout(r, 50));

      expect(server.received.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(server.received[0] ?? "{}");
      expect(parsed.type).toBe("agent:message");

      await transport.close();
    });

    it("queues frames when disconnected", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );

      // Send before connecting — should queue
      transport.send(testFrame);
      expect(server.received.length).toBe(0);

      // Connect — should drain queue
      await transport.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect(server.received.length).toBeGreaterThanOrEqual(1);
      await transport.close();
    });
  });

  describe("frame receiving", () => {
    it("delivers received frames to handlers", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );

      const received: NodeFrame[] = [];
      transport.onFrame((f) => received.push(f));

      await transport.connect();
      await new Promise((r) => setTimeout(r, 30));

      // Send a frame from server
      const frame: NodeFrame = {
        nodeId: "node-1",
        agentId: "a1",
        correlationId: "c1",
        type: "agent:dispatch",
        payload: {},
      };
      for (const client of server.clients) {
        client.send(JSON.stringify(frame));
      }

      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]?.type).toBe("agent:dispatch");

      await transport.close();
    });

    it("unsubscribes frame handler", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );

      const received: NodeFrame[] = [];
      const unsub = transport.onFrame((f) => received.push(f));
      unsub();

      await transport.connect();
      await new Promise((r) => setTimeout(r, 30));

      for (const client of server.clients) {
        client.send(
          JSON.stringify({
            nodeId: "n",
            agentId: "a",
            correlationId: "c",
            type: "agent:message",
            payload: {},
          }),
        );
      }

      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBe(0);

      await transport.close();
    });
  });

  describe("event emission", () => {
    it("emits connected event", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );

      const events: NodeEvent[] = [];
      transport.onEvent((e) => events.push(e));

      await transport.connect();

      const types = events.map((e) => e.type);
      expect(types).toContain("connected");

      await transport.close();
    });

    it("emits disconnected event on close", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );

      const events: NodeEvent[] = [];
      transport.onEvent((e) => events.push(e));

      await transport.connect();

      // Server closes the connection cleanly
      for (const client of server.clients) {
        client.close(1000, "test close");
      }

      await new Promise((r) => setTimeout(r, 50));

      const types = events.map((e) => e.type);
      expect(types).toContain("disconnected");

      await transport.close();
    });

    it("unsubscribes event listeners", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: server.url },
        defaultHeartbeatConfig,
      );

      const events: NodeEvent[] = [];
      const unsub = transport.onEvent((e) => events.push(e));
      unsub();

      await transport.connect();
      expect(events.length).toBe(0);

      await transport.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Auth-aware server helper
// ---------------------------------------------------------------------------

type AuthMode = "token_only" | "challenge" | "reject";

interface AuthServer {
  readonly url: string;
  readonly close: () => void;
  readonly clients: ServerWebSocket<unknown>[];
  readonly received: string[];
}

function startAuthServer(mode: AuthMode, challengeNonce = "test-nonce"): AuthServer {
  const clients: ServerWebSocket<unknown>[] = [];
  const received: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      server.upgrade(req);
      return undefined;
    },
    websocket: {
      open(ws) {
        clients.push(ws);
      },
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
        received.push(text);

        let frame: { type?: string; nodeId?: string; payload?: unknown } | undefined;
        try {
          frame = JSON.parse(text) as typeof frame;
        } catch {
          return;
        }
        if (frame === undefined) return;

        if (frame.type === "node:auth") {
          if (mode === "reject") {
            // Reject auth
            ws.send(
              JSON.stringify({
                nodeId: frame.nodeId ?? "",
                agentId: "",
                correlationId: "gw-ack",
                type: "node:auth_ack",
                payload: { success: false, reason: "access denied" },
              }),
            );
          } else if (mode === "challenge") {
            // Send challenge
            ws.send(
              JSON.stringify({
                nodeId: frame.nodeId ?? "",
                agentId: "",
                correlationId: "gw-challenge",
                type: "node:auth_challenge",
                payload: { challenge: challengeNonce },
              }),
            );
          } else {
            // Token-only: accept immediately
            ws.send(
              JSON.stringify({
                nodeId: frame.nodeId ?? "",
                agentId: "",
                correlationId: "gw-ack",
                type: "node:auth_ack",
                payload: { success: true },
              }),
            );
          }
        } else if (frame.type === "node:auth_response") {
          // Accept after challenge response
          ws.send(
            JSON.stringify({
              nodeId: frame.nodeId ?? "",
              agentId: "",
              correlationId: "gw-ack",
              type: "node:auth_ack",
              payload: { success: true },
            }),
          );
        }
      },
      close(ws) {
        const idx = clients.indexOf(ws);
        if (idx >= 0) clients.splice(idx, 1);
      },
    },
  });

  return {
    url: `ws://localhost:${server.port}`,
    close() {
      for (const c of [...clients]) c.close(1000);
      clients.length = 0;
      server.stop(true);
    },
    clients,
    received,
  };
}

const defaultAuthConfig: AuthConfig = {
  token: "test-token-123",
  timeoutMs: 5_000,
};

// ---------------------------------------------------------------------------
// Auth transport tests
// ---------------------------------------------------------------------------

describe("Transport with auth", () => {
  describe("token-only auth", () => {
    let authServer: AuthServer;

    beforeEach(() => {
      authServer = startAuthServer("token_only");
    });
    afterEach(() => {
      authServer.close();
    });

    it("connects and authenticates with token", async () => {
      const events: NodeEvent[] = [];
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: authServer.url },
        defaultHeartbeatConfig,
        defaultAuthConfig,
      );
      transport.onEvent((e) => events.push(e));

      await transport.connect();
      expect(transport.state()).toBe("connected");

      const types = events.map((e) => e.type);
      expect(types).toContain("auth_started");
      expect(types).toContain("auth_success");
      expect(types).toContain("connected");

      // Verify auth frame was sent
      expect(authServer.received.length).toBeGreaterThanOrEqual(1);
      const authFrame = JSON.parse(authServer.received[0] ?? "{}");
      expect(authFrame.type).toBe("node:auth");
      expect(authFrame.payload?.token).toBe("test-token-123");

      await transport.close();
    });

    it("drains queued frames after auth completes", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: authServer.url },
        defaultHeartbeatConfig,
        defaultAuthConfig,
      );

      // Queue a frame before connecting
      const testFrame: NodeFrame = {
        nodeId: "node-1",
        agentId: "a1",
        correlationId: "c1",
        type: "agent:message",
        payload: { text: "queued" },
      };
      transport.send(testFrame);

      await transport.connect();
      await new Promise((r) => setTimeout(r, 50));

      // Should have auth frame + queued frame
      const types = authServer.received.map((r) => {
        const parsed = JSON.parse(r);
        return parsed.type as string;
      });
      expect(types).toContain("node:auth");
      expect(types).toContain("agent:message");

      await transport.close();
    });
  });

  describe("challenge/response auth", () => {
    let authServer: AuthServer;
    const nonce = "challenge-nonce-xyz";

    beforeEach(() => {
      authServer = startAuthServer("challenge", nonce);
    });
    afterEach(() => {
      authServer.close();
    });

    it("handles challenge and sends HMAC response", async () => {
      const authWithSecret: AuthConfig = {
        token: "tok-hmac",
        secret: "my-secret-key",
        timeoutMs: 5_000,
      };
      const events: NodeEvent[] = [];
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: authServer.url },
        defaultHeartbeatConfig,
        authWithSecret,
      );
      transport.onEvent((e) => events.push(e));

      await transport.connect();
      expect(transport.state()).toBe("connected");

      // Should have sent: node:auth, node:auth_response
      await new Promise((r) => setTimeout(r, 50));
      const types = authServer.received.map((r) => {
        const parsed = JSON.parse(r);
        return parsed.type as string;
      });
      expect(types).toContain("node:auth");
      expect(types).toContain("node:auth_response");

      // Verify HMAC
      const responseFrame = authServer.received.find((r) => {
        const parsed = JSON.parse(r);
        return parsed.type === "node:auth_response";
      });
      const parsed = JSON.parse(responseFrame ?? "{}");
      const expectedHmac = await signChallenge(nonce, "my-secret-key");
      expect(parsed.payload?.response).toBe(expectedHmac);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("auth_started");
      expect(eventTypes).toContain("auth_success");

      await transport.close();
    });
  });

  describe("auth rejection", () => {
    let authServer: AuthServer;

    beforeEach(() => {
      authServer = startAuthServer("reject");
    });
    afterEach(() => {
      authServer.close();
    });

    it("rejects connection when Gateway denies auth", async () => {
      const events: NodeEvent[] = [];
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: authServer.url },
        defaultHeartbeatConfig,
        defaultAuthConfig,
      );
      transport.onEvent((e) => events.push(e));

      await expect(transport.connect()).rejects.toThrow("Auth failed");

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("auth_started");
      expect(eventTypes).toContain("auth_failed");

      await transport.close();
    });
  });

  describe("auth timeout", () => {
    let silentServer: MiniServer;

    beforeEach(() => {
      // Server that never responds — simulates Gateway not supporting auth
      silentServer = startServer();
    });
    afterEach(() => {
      silentServer.close();
    });

    it("rejects when auth times out", async () => {
      const shortTimeoutAuth: AuthConfig = {
        token: "tok-timeout",
        timeoutMs: 100,
      };
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: silentServer.url },
        defaultHeartbeatConfig,
        shortTimeoutAuth,
      );

      await expect(transport.connect()).rejects.toThrow("Auth failed");

      await transport.close();
    });
  });

  describe("no auth (backwards compat)", () => {
    let plainServer: MiniServer;

    beforeEach(() => {
      plainServer = startServer();
    });
    afterEach(() => {
      plainServer.close();
    });

    it("connects without auth when authConfig is undefined", async () => {
      const transport = createTransport(
        "node-1",
        { ...defaultGatewayConfig, url: plainServer.url },
        defaultHeartbeatConfig,
        undefined,
      );

      await transport.connect();
      expect(transport.state()).toBe("connected");

      // No auth frames sent
      await new Promise((r) => setTimeout(r, 30));
      const hasAuth = plainServer.received.some((r) => {
        try {
          const parsed = JSON.parse(r);
          return parsed.type === "node:auth";
        } catch {
          return false;
        }
      });
      expect(hasAuth).toBe(false);

      await transport.close();
    });
  });
});
