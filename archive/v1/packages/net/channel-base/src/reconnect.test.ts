import { describe, expect, mock, test } from "bun:test";
import type { DisconnectInfo } from "./reconnect.js";
import { createReconnector } from "./reconnect.js";

describe("createReconnector", () => {
  test("start() calls connect and onConnected on success", async () => {
    const onConnected = mock(() => {});
    const onDisconnected = mock((_info?: DisconnectInfo) => {});
    const onGiveUp = mock((_e: unknown, _info?: DisconnectInfo) => {});

    const reconnector = createReconnector({
      connect: async () => {},
      onConnected,
      onDisconnected,
      onGiveUp,
    });

    await reconnector.start();

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(reconnector.isConnected()).toBe(true);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test("isConnected() returns false before start", () => {
    const reconnector = createReconnector({
      connect: async () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      onGiveUp: () => {},
    });

    expect(reconnector.isConnected()).toBe(false);
  });

  test("retries on connect failure then succeeds", async () => {
    // let justified: tracks call count for failing then succeeding
    let calls = 0;
    const connectFn = async (): Promise<void> => {
      calls += 1;
      if (calls < 3) {
        throw new Error("connection refused");
      }
    };

    const onConnected = mock(() => {});
    const onGiveUp = mock((_e: unknown, _info?: DisconnectInfo) => {});

    const reconnector = createReconnector({
      connect: connectFn,
      onConnected,
      onDisconnected: () => {},
      onGiveUp,
      retry: {
        maxRetries: 5,
        backoffMultiplier: 2,
        initialDelayMs: 1, // fast for tests
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    await reconnector.start();

    expect(calls).toBe(3);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(reconnector.isConnected()).toBe(true);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test("calls onGiveUp when all retries exhausted", async () => {
    const connectError = new Error("permanent failure");
    const onGiveUp = mock((_e: unknown, _info?: DisconnectInfo) => {});

    const reconnector = createReconnector({
      connect: async () => {
        throw connectError;
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onGiveUp,
      retry: {
        maxRetries: 2,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    await reconnector.start();

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(reconnector.isConnected()).toBe(false);
  });

  test("stop() prevents further reconnection attempts", async () => {
    // let justified: tracks call count
    let _calls = 0;
    const connectFn = async (): Promise<void> => {
      _calls += 1;
      throw new Error("fail");
    };

    const reconnector = createReconnector({
      connect: connectFn,
      onConnected: () => {},
      onDisconnected: () => {},
      onGiveUp: () => {},
      retry: {
        maxRetries: 10,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    // Start and immediately stop
    const startPromise = reconnector.start();
    reconnector.stop();
    await startPromise;

    expect(reconnector.isConnected()).toBe(false);
  });

  test("reconnect() calls onDisconnected and retries", async () => {
    const onDisconnected = mock((_info?: DisconnectInfo) => {});

    const reconnector = createReconnector({
      connect: async () => {},
      onConnected: () => {},
      onDisconnected,
      onGiveUp: () => {},
      retry: {
        maxRetries: 3,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    await reconnector.start();
    expect(reconnector.isConnected()).toBe(true);

    reconnector.reconnect();

    // Give async reconnect loop time to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(reconnector.isConnected()).toBe(true);
  });

  test("reconnect() is no-op when stopped", async () => {
    const onDisconnected = mock((_info?: DisconnectInfo) => {});

    const reconnector = createReconnector({
      connect: async () => {},
      onConnected: () => {},
      onDisconnected,
      onGiveUp: () => {},
    });

    await reconnector.start();
    reconnector.stop();
    reconnector.reconnect();

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  test("resets attempt counter on successful reconnection", async () => {
    // let justified: tracks call count
    let connectCalls = 0;
    const connectFn = async (): Promise<void> => {
      connectCalls += 1;
      // First connect succeeds, second call fails once then succeeds
      if (connectCalls === 2) {
        throw new Error("transient");
      }
    };

    const onConnected = mock(() => {});

    const reconnector = createReconnector({
      connect: connectFn,
      onConnected,
      onDisconnected: () => {},
      onGiveUp: () => {},
      retry: {
        maxRetries: 3,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    await reconnector.start();
    expect(onConnected).toHaveBeenCalledTimes(1);

    // Trigger reconnect
    reconnector.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have reconnected successfully (attempt counter was reset)
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  test("onDisconnected receives DisconnectInfo with code and reason", async () => {
    const onDisconnected = mock((_info?: DisconnectInfo) => {});

    const reconnector = createReconnector({
      connect: async () => {},
      onConnected: () => {},
      onDisconnected,
      onGiveUp: () => {},
      retry: {
        maxRetries: 3,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    await reconnector.start();

    const info: DisconnectInfo = { code: 4004, reason: "Session expired" };
    reconnector.reconnect(info);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith(info);
  });

  test("onGiveUp receives DisconnectInfo from last disconnect", async () => {
    const onGiveUp = mock((_e: unknown, _info?: DisconnectInfo) => {});
    const info: DisconnectInfo = { code: 4008, reason: "Session store failure" };

    // Start succeeds first (connect throws), but we need to trigger via reconnect
    // to pass info. Use start first with a working connect, then break it.
    // let justified: controls whether connect should fail
    let shouldFail = false;
    const reconnector2 = createReconnector({
      connect: async () => {
        if (shouldFail) throw new Error("fail");
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onGiveUp,
      retry: {
        maxRetries: 1,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    await reconnector2.start();
    shouldFail = true;
    reconnector2.reconnect(info);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    const callArgs = onGiveUp.mock.calls[0];
    expect(callArgs?.[1]).toEqual(info);
  });

  test("maxRetries: Infinity never calls onGiveUp (stopped via stop())", async () => {
    const onGiveUp = mock((_e: unknown, _info?: DisconnectInfo) => {});
    // let justified: tracks connect attempt count
    let connectAttempts = 0;

    const reconnector = createReconnector({
      connect: async () => {
        connectAttempts += 1;
        throw new Error("always fail");
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onGiveUp,
      retry: {
        maxRetries: Infinity,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 5,
        jitter: false,
      },
    });

    const startPromise = reconnector.start();
    // Wait for a few attempts then stop
    await new Promise((resolve) => setTimeout(resolve, 50));
    reconnector.stop();
    await startPromise;

    expect(connectAttempts).toBeGreaterThan(1);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(reconnector.isConnected()).toBe(false);
  });

  test("attempts() returns current attempt count", async () => {
    // let justified: tracks call count
    let calls = 0;
    const connectFn = async (): Promise<void> => {
      calls += 1;
      if (calls <= 2) {
        throw new Error("fail");
      }
    };

    const reconnector = createReconnector({
      connect: connectFn,
      onConnected: () => {},
      onDisconnected: () => {},
      onGiveUp: () => {},
      retry: {
        maxRetries: 5,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    expect(reconnector.attempts()).toBe(0);
    await reconnector.start();
    // After successful connection, attempts should reset to 0
    expect(reconnector.attempts()).toBe(0);
  });
});
