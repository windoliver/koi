/**
 * Unit tests for createChannelAdapter().
 *
 * Uses a minimal MockEvent type and a test-setup helper to directly verify
 * the factory's internal behavior: observability callbacks, sendStatus
 * optionality, dispatch semantics, lifecycle idempotency, and rendering.
 */

import { describe, expect, test } from "bun:test";
import type {
  ChannelCapabilities,
  ChannelStatus,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";
import {
  type ChannelAdapterConfig,
  createChannelAdapter,
  type HealthStatus,
  type MessageNormalizer,
} from "./channel-adapter-factory.js";
import { text } from "./content-block-builders.js";

type MockEvent = { readonly text: string; readonly userId: string };

const ALL_CAPS: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: true,
  video: true,
  threads: true,
  supportsA2ui: true,
};

const TEXT_ONLY_CAPS: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

/** Normalizer that maps every MockEvent to an InboundMessage. */
const normalizeAll: MessageNormalizer<MockEvent> = (event) => ({
  content: [text(event.text)],
  senderId: event.userId,
  timestamp: 1000,
});

/** Normalizer that always returns null (every event ignored). */
const normalizeNone: MessageNormalizer<MockEvent> = (_event) => null;

interface TestSetup {
  readonly fire: (event: MockEvent) => void;
  readonly adapter: ReturnType<typeof createChannelAdapter> & {
    readonly healthCheck?: () => HealthStatus;
  };
  readonly sendLog: OutboundMessage[];
  readonly statusLog: ChannelStatus[];
  readonly errorLog: { readonly err: unknown; readonly message: InboundMessage }[];
  readonly ignoredLog: MockEvent[];
  readonly normErrorLog: { readonly error: unknown; readonly rawEvent: MockEvent }[];
}

function buildTest(
  normalize: MessageNormalizer<MockEvent>,
  opts?: {
    readonly withSendStatus?: boolean;
    readonly caps?: ChannelCapabilities;
    readonly withQueue?: boolean;
    readonly connectTimeoutMs?: number;
    readonly maxQueueSize?: number;
    readonly connectDelayMs?: number;
    readonly healthTimeoutMs?: number;
  },
): TestSetup {
  let platformEventHandler: ((e: MockEvent) => void) | undefined;
  const sendLog: OutboundMessage[] = [];
  const statusLog: ChannelStatus[] = [];
  const errorLog: { err: unknown; message: InboundMessage }[] = [];
  const ignoredLog: MockEvent[] = [];
  const normErrorLog: { error: unknown; rawEvent: MockEvent }[] = [];

  const config: ChannelAdapterConfig<MockEvent> = {
    name: "test",
    capabilities: opts?.caps ?? ALL_CAPS,
    platformConnect: async () => {
      if (opts?.connectDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, opts.connectDelayMs));
      }
    },
    platformDisconnect: async () => {},
    platformSend: async (msg) => {
      sendLog.push(msg);
    },
    onPlatformEvent: (handler) => {
      platformEventHandler = handler;
      return () => {
        platformEventHandler = undefined;
      };
    },
    normalize,
    onHandlerError: (err, message) => {
      errorLog.push({ err, message });
    },
    onIgnoredEvent: (event) => {
      ignoredLog.push(event);
    },
    onNormalizationError: (error, rawEvent) => {
      normErrorLog.push({ error, rawEvent });
    },
    ...(opts?.withSendStatus === true && {
      platformSendStatus: async (status) => {
        statusLog.push(status);
      },
    }),
    ...(opts?.withQueue === true && { queueWhenDisconnected: true }),
    ...(opts?.connectTimeoutMs !== undefined && { connectTimeoutMs: opts.connectTimeoutMs }),
    ...(opts?.maxQueueSize !== undefined && { maxQueueSize: opts.maxQueueSize }),
    ...(opts?.healthTimeoutMs !== undefined && { healthTimeoutMs: opts.healthTimeoutMs }),
  };

  return {
    adapter: createChannelAdapter(config) as TestSetup["adapter"],
    fire: (event) => {
      platformEventHandler?.(event);
    },
    sendLog,
    statusLog,
    errorLog,
    ignoredLog,
    normErrorLog,
  };
}

describe("createChannelAdapter", () => {
  describe("adapter identity", () => {
    test("name matches config", () => {
      const { adapter } = buildTest(normalizeAll);
      expect(adapter.name).toBe("test");
    });

    test("capabilities matches config", () => {
      const { adapter } = buildTest(normalizeAll);
      expect(adapter.capabilities).toEqual(ALL_CAPS);
    });
  });

  describe("sendStatus optionality", () => {
    test("sendStatus is absent when platformSendStatus not provided", () => {
      const { adapter } = buildTest(normalizeAll);
      expect(adapter.sendStatus).toBeUndefined();
    });

    test("sendStatus is present when platformSendStatus is provided", async () => {
      const { adapter, statusLog } = buildTest(normalizeAll, { withSendStatus: true });
      expect(adapter.sendStatus).toBeDefined();

      const status: ChannelStatus = { kind: "processing", turnIndex: 0 };
      await adapter.sendStatus?.(status);
      expect(statusLog).toHaveLength(1);
      expect(statusLog[0]).toEqual(status);
    });
  });

  describe("connection lifecycle", () => {
    test("connect() is idempotent — second call is no-op", async () => {
      const { adapter, fire } = buildTest(normalizeAll);
      await adapter.connect();
      await adapter.connect(); // second connect should not add another platform listener

      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      fire({ text: "hello", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Exactly one message, not two (idempotent connect)
      expect(received).toHaveLength(1);
      await adapter.disconnect();
    });

    test("disconnect() stops event delivery", async () => {
      const { adapter, fire } = buildTest(normalizeAll);
      await adapter.connect();

      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      fire({ text: "before", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toHaveLength(1);

      await adapter.disconnect();

      fire({ text: "after", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toHaveLength(1); // no new messages after disconnect
    });

    test("disconnect() without prior connect does not throw", async () => {
      const { adapter } = buildTest(normalizeAll);
      await adapter.disconnect();
    });
  });

  describe("handler dispatch", () => {
    test("handler receives messages after connect", async () => {
      const { adapter, fire } = buildTest(normalizeAll);
      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });
      await adapter.connect();

      fire({ text: "hello", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(1);
      expect(received[0]?.content).toEqual([{ kind: "text", text: "hello" }]);
      expect(received[0]?.senderId).toBe("u1");
      await adapter.disconnect();
    });

    test("multiple handlers receive the same message in parallel", async () => {
      const { adapter, fire } = buildTest(normalizeAll);
      const received1: InboundMessage[] = [];
      const received2: InboundMessage[] = [];

      adapter.onMessage(async (msg) => {
        received1.push(msg);
      });
      adapter.onMessage(async (msg) => {
        received2.push(msg);
      });

      await adapter.connect();
      fire({ text: "hi", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0]).toBe(received2[0]); // same InboundMessage reference
      await adapter.disconnect();
    });

    test("handler registered before connect receives events after connect", async () => {
      const { adapter, fire } = buildTest(normalizeAll);
      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect(); // connect after registering handler
      fire({ text: "late-connect", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(1);
      await adapter.disconnect();
    });
  });

  describe("onHandlerError callback", () => {
    test("throwing handler is isolated — other handlers still receive the message", async () => {
      const { adapter, fire, errorLog } = buildTest(normalizeAll);
      const received: InboundMessage[] = [];

      adapter.onMessage(async () => {
        throw new Error("handler boom");
      });
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      fire({ text: "test", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(1); // second handler still fired
      expect(errorLog).toHaveLength(1);
      expect(errorLog[0]?.err).toBeInstanceOf(Error);
      expect((errorLog[0]?.err as Error).message).toBe("handler boom");
      await adapter.disconnect();
    });

    test("onHandlerError receives the message that triggered the failure", async () => {
      const { adapter, fire, errorLog } = buildTest(normalizeAll);

      adapter.onMessage(async () => {
        throw new Error("oops");
      });

      await adapter.connect();
      fire({ text: "trigger", userId: "u2" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errorLog[0]?.message.senderId).toBe("u2");
      await adapter.disconnect();
    });
  });

  describe("onIgnoredEvent callback", () => {
    test("normalize returning null triggers onIgnoredEvent", async () => {
      const { adapter, fire, ignoredLog } = buildTest(normalizeNone);
      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      fire({ text: "ignored", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(0); // handler not called
      expect(ignoredLog).toHaveLength(1);
      expect(ignoredLog[0]).toEqual({ text: "ignored", userId: "u1" });
      await adapter.disconnect();
    });

    test("non-null normalize does not trigger onIgnoredEvent", async () => {
      const { adapter, fire, ignoredLog } = buildTest(normalizeAll);
      adapter.onMessage(async () => {});

      await adapter.connect();
      fire({ text: "delivered", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(ignoredLog).toHaveLength(0);
      await adapter.disconnect();
    });
  });

  describe("onMessage unsubscribe", () => {
    test("unsubscribed handler no longer receives messages", async () => {
      const { adapter, fire } = buildTest(normalizeAll);
      const received: InboundMessage[] = [];
      const unsub = adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      fire({ text: "before", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toHaveLength(1);

      unsub();

      fire({ text: "after", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toHaveLength(1); // no new message
      await adapter.disconnect();
    });

    test("unsubscribe is idempotent (double-call does not throw or double-remove)", async () => {
      const { adapter, fire } = buildTest(normalizeAll);
      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });
      const unsub = adapter.onMessage(async () => {});

      unsub();
      unsub(); // should not throw

      await adapter.connect();
      fire({ text: "check", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(1); // first handler still active
      await adapter.disconnect();
    });
  });

  describe("send — disconnected guard", () => {
    test("send() throws when called before connect", async () => {
      const { adapter } = buildTest(normalizeAll);
      await expect(adapter.send({ content: [{ kind: "text", text: "hi" }] })).rejects.toThrow(
        "is not connected",
      );
    });

    test("send() throws when called after disconnect", async () => {
      const { adapter } = buildTest(normalizeAll);
      await adapter.connect();
      await adapter.disconnect();
      await expect(adapter.send({ content: [{ kind: "text", text: "hi" }] })).rejects.toThrow(
        "is not connected",
      );
    });
  });

  describe("queueWhenDisconnected", () => {
    test("send() does not throw when disconnected and queueWhenDisconnected is true", async () => {
      const { adapter } = buildTest(normalizeAll, { withQueue: true });
      // Should not throw — message is buffered
      await adapter.send({ content: [{ kind: "text", text: "queued" }] });
    });

    test("queued messages are flushed in order on connect", async () => {
      const { adapter, sendLog } = buildTest(normalizeAll, { withQueue: true });

      await adapter.send({ content: [{ kind: "text", text: "first" }] });
      await adapter.send({ content: [{ kind: "text", text: "second" }] });
      expect(sendLog).toHaveLength(0); // not sent yet

      await adapter.connect();

      expect(sendLog).toHaveLength(2);
      expect(sendLog[0]?.content[0]).toEqual({ kind: "text", text: "first" });
      expect(sendLog[1]?.content[0]).toEqual({ kind: "text", text: "second" });
      await adapter.disconnect();
    });

    test("queue is cleared after drain — no double-send on reconnect", async () => {
      const { adapter, sendLog } = buildTest(normalizeAll, { withQueue: true });

      await adapter.send({ content: [{ kind: "text", text: "once" }] });

      await adapter.connect();
      await adapter.disconnect();
      await adapter.connect(); // second connect — queue already drained

      expect(sendLog).toHaveLength(1); // sent exactly once
      await adapter.disconnect();
    });

    test("messages sent while connected are not queued", async () => {
      const { adapter, sendLog } = buildTest(normalizeAll, { withQueue: true });
      await adapter.connect();

      await adapter.send({ content: [{ kind: "text", text: "live" }] });

      expect(sendLog).toHaveLength(1);
      await adapter.disconnect();
    });
  });

  describe("send — capability-aware rendering", () => {
    test("outbound blocks are downgraded before platformSend on limited-capability channel", async () => {
      const { adapter, sendLog } = buildTest(normalizeAll, { caps: TEXT_ONLY_CAPS });
      await adapter.connect();

      const message: OutboundMessage = {
        content: [
          { kind: "image", url: "https://example.com/img.png", alt: "sunset" },
          { kind: "text", text: "hello" },
        ],
      };
      await adapter.send(message);

      expect(sendLog).toHaveLength(1);
      expect(sendLog[0]?.content).toEqual([
        { kind: "text", text: "[Image: sunset]" },
        { kind: "text", text: "hello" },
      ]);
      await adapter.disconnect();
    });

    test("outbound blocks are not copied when no downgrade needed (fast path)", async () => {
      const { adapter, sendLog } = buildTest(normalizeAll, { caps: ALL_CAPS });
      await adapter.connect();

      const content = [{ kind: "text" as const, text: "hi" }] as const;
      const message: OutboundMessage = { content };
      await adapter.send(message);

      // Content reference unchanged (same array passed to platformSend)
      expect(sendLog[0]?.content).toBe(content);
      await adapter.disconnect();
    });
  });

  describe("connectTimeoutMs", () => {
    test("connect() rejects when platform takes longer than timeout", async () => {
      const { adapter } = buildTest(normalizeAll, {
        connectTimeoutMs: 50,
        connectDelayMs: 200,
      });
      await expect(adapter.connect()).rejects.toThrow("connect timed out after 50ms");
    });

    test("connect() succeeds when platform connects before timeout", async () => {
      const { adapter } = buildTest(normalizeAll, {
        connectTimeoutMs: 500,
        connectDelayMs: 10,
      });
      await adapter.connect();
      await adapter.disconnect();
    });

    test("connect timeout timer is cleared on successful connect", async () => {
      // Verify no lingering timers: if the timer leaked, it would reject
      // with a timeout error after connectTimeoutMs even though connect succeeded.
      const { adapter } = buildTest(normalizeAll, {
        connectTimeoutMs: 50,
        connectDelayMs: 5,
      });
      await adapter.connect();

      // Wait longer than the timeout — if the timer leaked, it would fire
      // and potentially cause unhandled rejections.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // If we get here without unhandled rejection, the timer was cleared.
      await adapter.disconnect();
    });

    test("connect timeout disabled when connectTimeoutMs is 0", async () => {
      const { adapter } = buildTest(normalizeAll, {
        connectTimeoutMs: 0,
        connectDelayMs: 50,
      });
      await adapter.connect();
      await adapter.disconnect();
    });
  });

  describe("maxQueueSize", () => {
    test("queue is bounded to maxQueueSize", async () => {
      const { adapter, sendLog } = buildTest(normalizeAll, {
        withQueue: true,
        maxQueueSize: 3,
      });

      // Queue 5 messages — first 2 should be dropped
      for (const i of [1, 2, 3, 4, 5]) {
        await adapter.send({ content: [{ kind: "text", text: `msg-${i}` }] });
      }

      await adapter.connect();

      expect(sendLog).toHaveLength(3);
      expect(sendLog[0]?.content[0]).toEqual({ kind: "text", text: "msg-3" });
      expect(sendLog[1]?.content[0]).toEqual({ kind: "text", text: "msg-4" });
      expect(sendLog[2]?.content[0]).toEqual({ kind: "text", text: "msg-5" });
      await adapter.disconnect();
    });

    test("queue drains fully on reconnect and resets dropped count", async () => {
      const { adapter, sendLog } = buildTest(normalizeAll, {
        withQueue: true,
        maxQueueSize: 2,
      });

      await adapter.send({ content: [{ kind: "text", text: "a" }] });
      await adapter.send({ content: [{ kind: "text", text: "b" }] });
      await adapter.send({ content: [{ kind: "text", text: "c" }] });

      await adapter.connect();
      expect(sendLog).toHaveLength(2);
      expect(sendLog[0]?.content[0]).toEqual({ kind: "text", text: "b" });
      expect(sendLog[1]?.content[0]).toEqual({ kind: "text", text: "c" });
      await adapter.disconnect();
    });
  });

  describe("onNormalizationError", () => {
    test("callback invoked when normalize throws synchronously", async () => {
      const throwingNormalizer: MessageNormalizer<MockEvent> = () => {
        throw new Error("parse fail");
      };
      const { adapter, fire, normErrorLog } = buildTest(throwingNormalizer);

      await adapter.connect();
      fire({ text: "bad", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(normErrorLog).toHaveLength(1);
      expect((normErrorLog[0]?.error as Error).message).toBe("parse fail");
      expect(normErrorLog[0]?.rawEvent).toEqual({ text: "bad", userId: "u1" });
      await adapter.disconnect();
    });

    test("callback invoked when normalize rejects asynchronously", async () => {
      const rejectingNormalizer: MessageNormalizer<MockEvent> = async () => {
        throw new Error("async parse fail");
      };
      const { adapter, fire, normErrorLog } = buildTest(rejectingNormalizer);

      await adapter.connect();
      fire({ text: "bad-async", userId: "u2" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(normErrorLog).toHaveLength(1);
      expect((normErrorLog[0]?.error as Error).message).toBe("async parse fail");
      await adapter.disconnect();
    });

    test("handlers are not called when normalization fails", async () => {
      const throwingNormalizer: MessageNormalizer<MockEvent> = () => {
        throw new Error("kaboom");
      };
      const { adapter, fire } = buildTest(throwingNormalizer);
      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();
      fire({ text: "bad", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(0);
      await adapter.disconnect();
    });
  });

  describe("healthCheck", () => {
    test("reports unhealthy when not connected", () => {
      const { adapter } = buildTest(normalizeAll);
      const status = adapter.healthCheck?.();
      expect(status?.healthy).toBe(false);
      expect(status?.lastEventAt).toBe(0);
    });

    test("reports healthy after receiving events", async () => {
      const { adapter, fire } = buildTest(normalizeAll, { healthTimeoutMs: 60_000 });
      await adapter.connect();

      fire({ text: "ping", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = adapter.healthCheck?.();
      expect(status?.healthy).toBe(true);
      expect(status?.lastEventAt).toBeGreaterThan(0);
      await adapter.disconnect();
    });

    test("reports unhealthy when events are stale", async () => {
      const { adapter, fire } = buildTest(normalizeAll, { healthTimeoutMs: 1 });
      await adapter.connect();

      fire({ text: "old", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = adapter.healthCheck?.();
      expect(status?.healthy).toBe(false);
      await adapter.disconnect();
    });

    test("staleness detection disabled when healthTimeoutMs is 0", async () => {
      const { adapter } = buildTest(normalizeAll, { healthTimeoutMs: 0 });
      await adapter.connect();
      // No events fired, but healthy because staleness disabled
      const status = adapter.healthCheck?.();
      expect(status?.healthy).toBe(true);
      await adapter.disconnect();
    });

    test("tracks lastEventAt even for ignored events", async () => {
      const { adapter, fire } = buildTest(normalizeNone, { healthTimeoutMs: 60_000 });
      await adapter.connect();

      fire({ text: "ignored", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = adapter.healthCheck?.();
      expect(status?.lastEventAt).toBeGreaterThan(0);
      await adapter.disconnect();
    });

    test("reports unhealthy after disconnect", async () => {
      const { adapter, fire } = buildTest(normalizeAll, { healthTimeoutMs: 60_000 });
      await adapter.connect();
      fire({ text: "hi", userId: "u1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await adapter.disconnect();

      const status = adapter.healthCheck?.();
      expect(status?.healthy).toBe(false);
    });
  });
});
