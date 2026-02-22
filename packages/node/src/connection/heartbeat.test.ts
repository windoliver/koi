import { describe, expect, it, mock } from "bun:test";
import { createHeartbeatMonitor } from "./heartbeat.js";

describe("heartbeat monitor", () => {
  // Use short intervals for fast tests
  const config = { interval: 50, timeout: 25 };

  it("starts and stops without error", () => {
    const hb = createHeartbeatMonitor(config, {
      onPing: () => {},
      onTimeout: () => {},
    });
    expect(hb.isActive()).toBe(false);
    hb.start();
    expect(hb.isActive()).toBe(true);
    hb.stop();
    expect(hb.isActive()).toBe(false);
  });

  it("calls onPing at the configured interval", async () => {
    const onPing = mock(() => {});
    const hb = createHeartbeatMonitor(config, {
      onPing,
      onTimeout: () => {},
    });

    hb.start();
    await new Promise((r) => setTimeout(r, 130));
    hb.stop();

    // With 50ms interval over 130ms, expect 2 pings
    expect(onPing).toHaveBeenCalledTimes(2);
  });

  it("does not call onTimeout when pong is received", async () => {
    const onTimeout = mock(() => {});
    const hb = createHeartbeatMonitor(config, {
      onPing: () => {
        // Simulate immediate pong
        hb.receivedPong();
      },
      onTimeout,
    });

    hb.start();
    await new Promise((r) => setTimeout(r, 130));
    hb.stop();

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("calls onTimeout when pong is not received", async () => {
    const onTimeout = mock(() => {});
    const hb = createHeartbeatMonitor(config, {
      onPing: () => {
        // Don't respond with pong
      },
      onTimeout,
    });

    hb.start();
    await new Promise((r) => setTimeout(r, 100));
    hb.stop();

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on start", () => {
    const onPing = mock(() => {});
    const hb = createHeartbeatMonitor(config, {
      onPing,
      onTimeout: () => {},
    });

    hb.start();
    hb.start(); // Second call should be a no-op
    hb.stop();
  });

  it("does not fire after stop", async () => {
    const onPing = mock(() => {});
    const hb = createHeartbeatMonitor(config, {
      onPing,
      onTimeout: () => {},
    });

    hb.start();
    hb.stop();
    await new Promise((r) => setTimeout(r, 100));

    expect(onPing).toHaveBeenCalledTimes(0);
  });
});
