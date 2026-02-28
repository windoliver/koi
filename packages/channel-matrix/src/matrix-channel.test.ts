import { describe, expect, mock, test } from "bun:test";
import { testChannelAdapter } from "@koi/test-utils";
import { createMatrixChannel } from "./matrix-channel.js";

/** Mock MatrixClient for testing. */
function createMockClient(): Record<string, unknown> {
  const handlers = new Map<string, (...args: readonly unknown[]) => void>();
  return {
    getUserId: mock(async () => "@bot:matrix.org"),
    start: mock(async () => {}),
    stop: mock(() => {}),
    on: mock((event: string, handler: (...args: readonly unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    off: mock((event: string, _handler: (...args: readonly unknown[]) => void) => {
      handlers.delete(event);
    }),
    sendText: mock(async () => "$event1"),
    sendMessage: mock(async () => "$event2"),
    joinRoom: mock(async () => "!room:matrix.org"),
    _emit: (event: string, ...args: readonly unknown[]) => {
      const handler = handlers.get(event);
      if (handler !== undefined) {
        handler(...args);
      }
    },
    _handlers: handlers,
  };
}

function makeAdapter(clientOverride?: ReturnType<typeof createMockClient>): {
  readonly adapter: ReturnType<typeof createMatrixChannel>;
  readonly client: ReturnType<typeof createMockClient>;
} {
  const client = clientOverride ?? createMockClient();
  const adapter = createMatrixChannel({
    homeserverUrl: "https://matrix.test",
    accessToken: "test-token",
    debounceMs: 0,
    _client: client,
  });
  return { adapter, client };
}

describe("createMatrixChannel", () => {
  describe("contract tests", () => {
    testChannelAdapter({
      createAdapter: () => makeAdapter().adapter,
    });
  });

  describe("capabilities", () => {
    test("declares expected capabilities", () => {
      const { adapter } = makeAdapter();
      expect(adapter.capabilities).toEqual({
        text: true,
        images: true,
        files: true,
        buttons: false,
        audio: false,
        video: false,
        threads: true,
        supportsA2ui: false,
      });
    });

    test("name is 'matrix'", () => {
      const { adapter } = makeAdapter();
      expect(adapter.name).toBe("matrix");
    });
  });

  describe("lifecycle", () => {
    test("connect calls client.start", async () => {
      const { adapter, client } = makeAdapter();
      await adapter.connect();
      expect(client.start).toHaveBeenCalledTimes(1);
      await adapter.disconnect();
    });

    test("disconnect calls client.stop", async () => {
      const { adapter, client } = makeAdapter();
      await adapter.connect();
      await adapter.disconnect();
      expect(client.stop).toHaveBeenCalledTimes(1);
    });

    test("registers room.invite handler for auto-join", async () => {
      const { adapter, client } = makeAdapter();
      await adapter.connect();
      expect(client.on).toHaveBeenCalled();
      const onCalls = (client.on as ReturnType<typeof mock>).mock.calls;
      const inviteCall = onCalls.find((c: readonly unknown[]) => c[0] === "room.invite");
      expect(inviteCall).toBeDefined();
      await adapter.disconnect();
    });
  });

  describe("message handling", () => {
    test("receives normalized message from room event", async () => {
      const { adapter, client } = makeAdapter();

      const received = new Promise<{ readonly senderId: string; readonly text: string }>(
        (resolve) => {
          adapter.onMessage(async (msg) => {
            const textBlock = msg.content.find((b) => b.kind === "text");
            if (textBlock !== undefined && textBlock.kind === "text") {
              resolve({ senderId: msg.senderId, text: textBlock.text });
            }
          });
        },
      );

      await adapter.connect();

      // Emit a room.message event through the mock
      const emit = client._emit as (event: string, ...args: readonly unknown[]) => void;
      emit("room.message", "!room1:matrix.org", {
        type: "m.room.message",
        sender: "@user:matrix.org",
        event_id: "$evt1",
        room_id: "!room1:matrix.org",
        content: { msgtype: "m.text", body: "hello from matrix" },
      });

      const result = await received;
      expect(result.senderId).toBe("@user:matrix.org");
      expect(result.text).toBe("hello from matrix");

      await adapter.disconnect();
    });
  });
});
