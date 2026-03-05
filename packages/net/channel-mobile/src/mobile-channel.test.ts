import { afterEach, describe, expect, test } from "bun:test";
import { testChannelAdapter } from "@koi/test-utils";
import type { MobileChannelAdapter } from "./config.js";
import { createMobileChannel } from "./mobile-channel.js";
import { DEFAULT_MOBILE_TOOLS } from "./tools.js";

/** Port range to avoid conflicts with other tests. */
const BASE_PORT = 19_100;
// let: monotonic port counter to avoid port reuse across tests
let portCounter = 0;
function nextPort(): number {
  return BASE_PORT + portCounter++;
}

/** Helper to create a connected test adapter. */
function makeAdapter(
  overrides: Partial<Parameters<typeof createMobileChannel>[0]> = {},
): MobileChannelAdapter {
  return createMobileChannel({
    port: nextPort(),
    tools: DEFAULT_MOBILE_TOOLS,
    ...overrides,
  });
}

describe("createMobileChannel", () => {
  describe("contract tests", () => {
    testChannelAdapter({
      createAdapter: () => makeAdapter(),
      testThreadId: "mobile:1",
    });
  });

  describe("capabilities", () => {
    test("declares all expected capabilities", () => {
      const adapter = makeAdapter();
      expect(adapter.capabilities).toEqual({
        text: true,
        images: true,
        files: true,
        buttons: true,
        audio: true,
        video: true,
        threads: true,
        supportsA2ui: false,
      });
    });

    test("name is 'mobile'", () => {
      const adapter = makeAdapter();
      expect(adapter.name).toBe("mobile");
    });
  });

  describe("tools", () => {
    test("exposes configured tools", () => {
      const adapter = makeAdapter({ tools: DEFAULT_MOBILE_TOOLS });
      expect(adapter.tools).toEqual(DEFAULT_MOBILE_TOOLS);
    });

    test("defaults to empty tools array when not configured", () => {
      const adapter = createMobileChannel({ port: nextPort() });
      expect(adapter.tools).toEqual([]);
    });
  });

  describe("connectedClients", () => {
    test("returns 0 before any connections", async () => {
      const adapter = makeAdapter();
      await adapter.connect();
      expect(adapter.connectedClients()).toBe(0);
      await adapter.disconnect();
    });
  });

  describe("lifecycle", () => {
    test("connect and disconnect complete without error", async () => {
      const adapter = makeAdapter();
      await adapter.connect();
      await adapter.disconnect();
    });

    test("disconnect is safe to call without prior connect", async () => {
      const adapter = makeAdapter();
      await adapter.disconnect();
    });
  });

  describe("WebSocket integration", () => {
    // let: adapter reference for cleanup in afterEach
    let adapter: MobileChannelAdapter | undefined;

    afterEach(async () => {
      if (adapter !== undefined) {
        await adapter.disconnect();
        adapter = undefined;
      }
    });

    test("receives message from WebSocket client", async () => {
      const port = nextPort();
      adapter = createMobileChannel({ port });

      const received = new Promise<{ readonly senderId: string; readonly text: string }>(
        (resolve) => {
          adapter?.onMessage(async (msg) => {
            const textBlock = msg.content.find((b) => b.kind === "text");
            if (textBlock !== undefined && textBlock.kind === "text") {
              resolve({ senderId: msg.senderId, text: textBlock.text });
            }
          });
        },
      );

      await adapter.connect();

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      ws.send(
        JSON.stringify({
          kind: "message",
          content: [{ kind: "text", text: "hello from mobile" }],
          senderId: "device-1",
        }),
      );

      const result = await received;
      expect(result.senderId).toBe("device-1");
      expect(result.text).toBe("hello from mobile");
      ws.close();
    });

    test("responds with pong to ping frame", async () => {
      const port = nextPort();
      adapter = createMobileChannel({ port });
      await adapter.connect();

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      const pong = new Promise<unknown>((resolve) => {
        ws.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      ws.send(JSON.stringify({ kind: "ping" }));
      const response = await pong;
      expect(response).toEqual({ kind: "pong" });
      ws.close();
    });

    test("tracks connected clients count", async () => {
      const port = nextPort();
      adapter = createMobileChannel({ port });
      await adapter.connect();

      expect(adapter.connectedClients()).toBe(0);

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });
      // Give time for the open handler to run
      await Bun.sleep(50);

      expect(adapter.connectedClients()).toBe(1);

      ws.close();
      await Bun.sleep(50);

      expect(adapter.connectedClients()).toBe(0);
    });

    test("auth flow rejects invalid token", async () => {
      const port = nextPort();
      adapter = createMobileChannel({
        port,
        authToken: "correct-token",
        features: { requireAuth: true },
      });
      await adapter.connect();

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      const error = new Promise<unknown>((resolve) => {
        ws.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      ws.send(JSON.stringify({ kind: "auth", token: "wrong-token" }));
      const response = await error;
      expect(response).toMatchObject({ kind: "error", message: "Authentication failed" });
      ws.close();
    });

    test("auth flow accepts valid token", async () => {
      const port = nextPort();
      adapter = createMobileChannel({
        port,
        authToken: "correct-token",
        features: { requireAuth: true },
      });

      const received = new Promise<string>((resolve) => {
        adapter?.onMessage(async (msg) => {
          const textBlock = msg.content.find((b) => b.kind === "text");
          if (textBlock !== undefined && textBlock.kind === "text") {
            resolve(textBlock.text);
          }
        });
      });

      await adapter.connect();

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      ws.send(JSON.stringify({ kind: "auth", token: "correct-token" }));
      await Bun.sleep(50);

      ws.send(
        JSON.stringify({
          kind: "message",
          content: [{ kind: "text", text: "authenticated msg" }],
          senderId: "device-1",
        }),
      );

      const text = await received;
      expect(text).toBe("authenticated msg");
      ws.close();
    });

    test("assigns threadId when message omits it", async () => {
      const port = nextPort();
      adapter = createMobileChannel({ port });

      const received = new Promise<string | undefined>((resolve) => {
        adapter?.onMessage(async (msg) => {
          resolve(msg.threadId);
        });
      });

      await adapter.connect();

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      ws.send(
        JSON.stringify({
          kind: "message",
          content: [{ kind: "text", text: "no thread" }],
          senderId: "device-1",
        }),
      );

      const threadId = await received;
      expect(threadId).toMatch(/^mobile:\d+$/);
      ws.close();
    });
  });
});
