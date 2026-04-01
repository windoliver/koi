import { describe, expect, mock, test } from "bun:test";
import type { ChannelCapabilities, InboundMessage, OutboundMessage } from "@koi/core";
import { createChannelAdapter } from "./channel-adapter-factory.js";

const TEXT_ONLY: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

/** Creates a minimal adapter for testing with platform event injection. */
function createTestAdapter(overrides: Record<string, unknown> = {}): {
  readonly adapter: ReturnType<typeof createChannelAdapter>;
  readonly inject: (event: string) => void;
} {
  // let requires justification: captured by onPlatformEvent callback
  let eventHandler: ((event: string) => void) | undefined;

  const adapter = createChannelAdapter<string>({
    name: "test",
    capabilities: TEXT_ONLY,
    platformConnect: async () => {},
    platformDisconnect: async () => {},
    platformSend: async () => {},
    onPlatformEvent: (handler) => {
      eventHandler = handler;
      return () => {
        eventHandler = undefined;
      };
    },
    normalize: (line: string) => ({
      content: [{ kind: "text", text: line }],
      senderId: "test-user",
      timestamp: Date.now(),
    }),
    ...overrides,
  });

  return {
    adapter,
    inject: (event: string) => {
      eventHandler?.(event);
    },
  };
}

describe("createChannelAdapter", () => {
  describe("lifecycle", () => {
    test("connect is idempotent", async () => {
      const connectFn = mock(async () => {});
      const { adapter } = createTestAdapter({ platformConnect: connectFn });
      await adapter.connect();
      await adapter.connect();
      expect(connectFn).toHaveBeenCalledTimes(1);
    });

    test("disconnect is idempotent", async () => {
      const disconnectFn = mock(async () => {});
      const { adapter } = createTestAdapter({ platformDisconnect: disconnectFn });
      await adapter.connect();
      await adapter.disconnect();
      await adapter.disconnect();
      expect(disconnectFn).toHaveBeenCalledTimes(1);
    });

    test("disconnect without connect does not throw", async () => {
      const { adapter } = createTestAdapter();
      await adapter.disconnect(); // should not throw
    });

    test("send before connect throws", async () => {
      const { adapter } = createTestAdapter();
      const message: OutboundMessage = { content: [{ kind: "text", text: "hi" }] };
      await expect(adapter.send(message)).rejects.toThrow("is not connected");
    });

    test("concurrent connect() calls only invoke platformConnect once", async () => {
      const connectFn = mock(async () => {
        await Bun.sleep(20);
      });
      const { adapter } = createTestAdapter({ platformConnect: connectFn });
      await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);
      expect(connectFn).toHaveBeenCalledTimes(1);
    });

    test("concurrent disconnect() calls only invoke platformDisconnect once", async () => {
      const disconnectFn = mock(async () => {
        await Bun.sleep(20);
      });
      const { adapter } = createTestAdapter({ platformDisconnect: disconnectFn });
      await adapter.connect();
      await Promise.all([adapter.disconnect(), adapter.disconnect(), adapter.disconnect()]);
      expect(disconnectFn).toHaveBeenCalledTimes(1);
    });

    test("send() rejects once disconnect() begins, even before teardown completes", async () => {
      const disconnectFn = mock(async () => {
        // Simulate slow teardown
        await Bun.sleep(50);
      });
      const { adapter } = createTestAdapter({ platformDisconnect: disconnectFn });
      await adapter.connect();

      // Start disconnect (don't await yet)
      const disconnectPromise = adapter.disconnect();

      // Give the lifecycle queue a tick to start the disconnect operation
      await Bun.sleep(5);

      // send() should reject because connected is already false
      const message: OutboundMessage = { content: [{ kind: "text", text: "too late" }] };
      await expect(adapter.send(message)).rejects.toThrow("is not connected");

      await disconnectPromise;
    });

    test("connect() rolls back if onPlatformEvent throws", async () => {
      const connectFn = mock(async () => {});
      const disconnectFn = mock(async () => {});
      const { adapter } = createTestAdapter({
        platformConnect: connectFn,
        platformDisconnect: disconnectFn,
        onPlatformEvent: () => {
          throw new Error("subscription failed");
        },
      });

      // connect() should reject with the subscription error
      await expect(adapter.connect()).rejects.toThrow("subscription failed");

      // platformDisconnect should have been called to roll back
      expect(disconnectFn).toHaveBeenCalledTimes(1);

      // Adapter should NOT be connected — send should reject
      const message: OutboundMessage = { content: [{ kind: "text", text: "hi" }] };
      await expect(adapter.send(message)).rejects.toThrow("is not connected");

      // A subsequent connect() should work (not stuck in wedged state)
      const { adapter: adapter2 } = createTestAdapter({
        platformConnect: connectFn,
        platformDisconnect: disconnectFn,
      });
      await adapter2.connect();
      await adapter2.send({ content: [{ kind: "text", text: "works" }] });
      await adapter2.disconnect();
    });

    test("events emitted during listener registration are delivered (not dropped)", async () => {
      const received: InboundMessage[] = [];

      const adapter = createChannelAdapter<string>({
        name: "test",
        capabilities: TEXT_ONLY,
        platformConnect: async () => {},
        platformDisconnect: async () => {},
        platformSend: async () => {},
        onPlatformEvent: (handler) => {
          // Simulate a platform that emits a buffered event immediately
          // during listener registration (before connect() sets connected=true)
          handler("startup-event");
          return () => {};
        },
        normalize: (line: string) => ({
          content: [{ kind: "text", text: line }],
          senderId: "test",
          timestamp: Date.now(),
        }),
      });

      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      await Bun.sleep(10);

      // The startup event should have been delivered, not dropped
      expect(received).toHaveLength(1);
      expect(received[0]?.content).toEqual([{ kind: "text", text: "startup-event" }]);

      await adapter.disconnect();
    });
  });

  describe("handler dispatch", () => {
    test("delivers messages to registered handlers", async () => {
      const { adapter, inject } = createTestAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      inject("hello");
      await Bun.sleep(10);

      expect(received).toHaveLength(1);
      expect(received[0]?.content).toEqual([{ kind: "text", text: "hello" }]);
    });

    test("multiple handlers receive the same message", async () => {
      const { adapter, inject } = createTestAdapter();
      const received1: InboundMessage[] = [];
      const received2: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received1.push(msg);
      });
      adapter.onMessage(async (msg) => {
        received2.push(msg);
      });

      await adapter.connect();
      inject("multi");
      await Bun.sleep(10);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });

    test("same handler registered twice: unsubscribing one preserves the other", async () => {
      const { adapter, inject } = createTestAdapter();
      const received: InboundMessage[] = [];
      const handler = async (msg: InboundMessage): Promise<void> => {
        received.push(msg);
      };

      const unsub1 = adapter.onMessage(handler);
      const unsub2 = adapter.onMessage(handler);

      await adapter.connect();
      inject("both");
      await Bun.sleep(10);
      // Both subscriptions deliver
      expect(received).toHaveLength(2);

      // Unsubscribe only the first registration
      unsub1();
      inject("one-removed");
      await Bun.sleep(10);
      // Only one subscription remains
      expect(received).toHaveLength(3);

      unsub2();
      inject("both-removed");
      await Bun.sleep(10);
      // No subscriptions remain
      expect(received).toHaveLength(3);

      await adapter.disconnect();
    });

    test("unsubscribe stops handler from receiving messages", async () => {
      const { adapter, inject } = createTestAdapter();
      const received: InboundMessage[] = [];
      const unsub = adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      inject("before");
      await Bun.sleep(10);
      expect(received).toHaveLength(1);

      unsub();
      inject("after");
      await Bun.sleep(10);
      expect(received).toHaveLength(1);
    });

    test("unsubscribe is idempotent", () => {
      const { adapter } = createTestAdapter();
      const unsub = adapter.onMessage(async () => {});
      unsub();
      unsub(); // should not throw
    });

    test("handler that throws does not prevent other handlers", async () => {
      const errorFn = mock((_err: unknown, _msg: InboundMessage) => {});
      const { adapter, inject } = createTestAdapter({ onHandlerError: errorFn });
      const received: InboundMessage[] = [];

      adapter.onMessage(async () => {
        throw new Error("boom");
      });
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      inject("test");
      await Bun.sleep(10);

      expect(received).toHaveLength(1);
      expect(errorFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("send with renderBlocks", () => {
    test("downgrades unsupported blocks before platformSend", async () => {
      const sentMessages: OutboundMessage[] = [];
      const { adapter } = createTestAdapter({
        platformSend: async (msg: OutboundMessage) => {
          sentMessages.push(msg);
        },
      });

      await adapter.connect();
      await adapter.send({
        content: [
          { kind: "image", url: "pic.png", alt: "photo" },
          { kind: "text", text: "hello" },
        ],
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.content).toEqual([
        { kind: "text", text: "[Image: photo]" },
        { kind: "text", text: "hello" },
      ]);
    });
  });

  describe("sendStatus", () => {
    test("omitted when platformSendStatus not provided", () => {
      const { adapter } = createTestAdapter();
      expect(adapter.sendStatus).toBeUndefined();
    });

    test("delegates to platformSendStatus when provided", async () => {
      const statusFn = mock(async () => {});
      const { adapter } = createTestAdapter({ platformSendStatus: statusFn });
      await adapter.connect();
      await adapter.sendStatus?.({ kind: "processing", turnIndex: 0 });
      expect(statusFn).toHaveBeenCalledTimes(1);
    });

    test("disconnect drains in-flight sendStatus before teardown", async () => {
      const events: string[] = [];
      const statusFn = mock(async () => {
        events.push("status-start");
        await Bun.sleep(30);
        events.push("status-end");
      });
      const { adapter } = createTestAdapter({
        platformSendStatus: statusFn,
        platformDisconnect: async () => {
          events.push("disconnect");
        },
      });

      await adapter.connect();

      // Start a slow status write (don't await)
      const statusPromise = adapter.sendStatus?.({ kind: "processing", turnIndex: 0 });
      await Bun.sleep(5);
      // Disconnect while status is in-flight
      const disconnectPromise = adapter.disconnect();

      await Promise.all([statusPromise, disconnectPromise]);

      // Status must complete before platformDisconnect
      expect(events).toEqual(["status-start", "status-end", "disconnect"]);
    });
  });

  test("name and capabilities are exposed", () => {
    const { adapter } = createTestAdapter();
    expect(adapter.name).toBe("test");
    expect(adapter.capabilities).toEqual(TEXT_ONLY);
  });

  describe("disconnect blocks inbound events immediately", () => {
    test("events arriving after disconnect starts are dropped", async () => {
      const received: InboundMessage[] = [];
      // let requires justification: captured by onPlatformEvent callback
      let eventHandler: ((event: string) => void) | undefined;

      const adapter = createChannelAdapter<string>({
        name: "test",
        capabilities: TEXT_ONLY,
        platformConnect: async () => {},
        platformDisconnect: async () => {
          // Simulate slow teardown — events could arrive here
          await Bun.sleep(50);
        },
        platformSend: async () => {},
        onPlatformEvent: (handler) => {
          eventHandler = handler;
          return () => {
            eventHandler = undefined;
          };
        },
        normalize: (line: string) => ({
          content: [{ kind: "text", text: line }],
          senderId: "test",
          timestamp: Date.now(),
        }),
      });

      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();

      // Message before disconnect — should be delivered
      eventHandler?.("before");
      await Bun.sleep(10);
      expect(received).toHaveLength(1);

      // Start disconnect (don't await)
      const disconnectPromise = adapter.disconnect();
      await Bun.sleep(5);

      // Event during disconnect — should be dropped (connected=false)
      eventHandler?.("during-disconnect");
      await Bun.sleep(10);
      expect(received).toHaveLength(1);

      await disconnectPromise;
    });

    test("async normalize resolving after disconnect does not dispatch", async () => {
      const received: InboundMessage[] = [];
      // let requires justification: captured by onPlatformEvent callback
      let eventHandler: ((event: string) => void) | undefined;
      // let requires justification: controls when normalize resolves
      let resolveNormalize: ((msg: InboundMessage) => void) | undefined;

      const adapter = createChannelAdapter<string>({
        name: "test",
        capabilities: TEXT_ONLY,
        platformConnect: async () => {},
        platformDisconnect: async () => {},
        platformSend: async () => {},
        onPlatformEvent: (handler) => {
          eventHandler = handler;
          return () => {
            eventHandler = undefined;
          };
        },
        normalize: () =>
          new Promise<InboundMessage>((resolve) => {
            resolveNormalize = resolve;
          }),
      });

      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();

      // Inject event — normalize starts but doesn't resolve yet
      eventHandler?.("slow-event");
      await Bun.sleep(5);
      expect(received).toHaveLength(0);

      // Disconnect while normalize is still pending
      const disconnectPromise = adapter.disconnect();
      await Bun.sleep(5);

      // Now resolve normalize — should NOT dispatch because connected=false
      resolveNormalize?.({
        content: [{ kind: "text", text: "stale" }],
        senderId: "test",
        timestamp: Date.now(),
      });
      await Bun.sleep(10);

      expect(received).toHaveLength(0);
      await disconnectPromise;
    });
  });

  describe("disconnect drains in-flight sends", () => {
    test("disconnect waits for slow send to complete before teardown", async () => {
      const events: string[] = [];
      const { adapter } = createTestAdapter({
        platformSend: async () => {
          events.push("send-start");
          await Bun.sleep(50);
          events.push("send-end");
        },
        platformDisconnect: async () => {
          events.push("disconnect");
        },
      });

      await adapter.connect();

      // Start a slow send (don't await)
      const sendPromise = adapter.send({ content: [{ kind: "text", text: "slow" }] });
      // Give send a tick to start
      await Bun.sleep(5);
      // Start disconnect while send is in-flight
      const disconnectPromise = adapter.disconnect();

      await Promise.all([sendPromise, disconnectPromise]);

      // send must finish BEFORE platformDisconnect runs
      expect(events).toEqual(["send-start", "send-end", "disconnect"]);
    });

    test("concurrent sends are serialized and don't interleave", async () => {
      const events: string[] = [];
      const { adapter } = createTestAdapter({
        platformSend: async (msg: OutboundMessage) => {
          const text = msg.content[0]?.kind === "text" ? msg.content[0].text : "?";
          events.push(`start:${text}`);
          await Bun.sleep(20);
          events.push(`end:${text}`);
        },
      });

      await adapter.connect();

      // Fire two sends concurrently
      const p1 = adapter.send({ content: [{ kind: "text", text: "A" }] });
      const p2 = adapter.send({ content: [{ kind: "text", text: "B" }] });
      await Promise.all([p1, p2]);

      // A must fully complete before B starts
      expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);

      await adapter.disconnect();
    });
  });

  describe("normalization error hook", () => {
    test("calls onNormalizationError when sync normalize throws", async () => {
      const normErrorFn = mock((_err: unknown, _event: unknown) => {});
      // let requires justification: captured by onPlatformEvent callback
      let eventHandler: ((event: string) => void) | undefined;

      const adapter = createChannelAdapter<string>({
        name: "test",
        capabilities: TEXT_ONLY,
        platformConnect: async () => {},
        platformDisconnect: async () => {},
        platformSend: async () => {},
        onPlatformEvent: (handler) => {
          eventHandler = handler;
          return () => {
            eventHandler = undefined;
          };
        },
        normalize: () => {
          throw new Error("sync boom");
        },
        onNormalizationError: normErrorFn,
      });

      await adapter.connect();
      eventHandler?.("bad-event");
      await Bun.sleep(10);

      expect(normErrorFn).toHaveBeenCalledTimes(1);
      const [err, rawEvent] = normErrorFn.mock.calls[0] as [unknown, unknown];
      expect(err).toBeInstanceOf(Error);
      expect(rawEvent).toBe("bad-event");

      await adapter.disconnect();
    });

    test("calls onNormalizationError when async normalize rejects", async () => {
      const normErrorFn = mock((_err: unknown, _event: unknown) => {});
      // let requires justification: captured by onPlatformEvent callback
      let eventHandler: ((event: string) => void) | undefined;

      const adapter = createChannelAdapter<string>({
        name: "test",
        capabilities: TEXT_ONLY,
        platformConnect: async () => {},
        platformDisconnect: async () => {},
        platformSend: async () => {},
        onPlatformEvent: (handler) => {
          eventHandler = handler;
          return () => {
            eventHandler = undefined;
          };
        },
        normalize: async () => {
          throw new Error("bad payload");
        },
        onNormalizationError: normErrorFn,
      });

      await adapter.connect();
      eventHandler?.("corrupt-data");
      await Bun.sleep(10);

      expect(normErrorFn).toHaveBeenCalledTimes(1);
      const [err, rawEvent] = normErrorFn.mock.calls[0] as [unknown, unknown];
      expect(err).toBeInstanceOf(Error);
      expect(rawEvent).toBe("corrupt-data");

      await adapter.disconnect();
    });

    test("drops event silently when no onNormalizationError provided", async () => {
      // let requires justification: captured by onPlatformEvent callback
      let eventHandler: ((event: string) => void) | undefined;

      const adapter = createChannelAdapter<string>({
        name: "test",
        capabilities: TEXT_ONLY,
        platformConnect: async () => {},
        platformDisconnect: async () => {},
        platformSend: async () => {},
        onPlatformEvent: (handler) => {
          eventHandler = handler;
          return () => {
            eventHandler = undefined;
          };
        },
        normalize: async () => {
          throw new Error("bad payload");
        },
        // No onNormalizationError — should not throw
      });

      await adapter.connect();
      eventHandler?.("corrupt-data");
      await Bun.sleep(10);
      // No crash — event silently dropped

      await adapter.disconnect();
    });
  });
});
