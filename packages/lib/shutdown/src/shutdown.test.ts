import { describe, expect, it, mock } from "bun:test";
import { createShutdownHandler } from "./shutdown.js";

describe("ShutdownHandler", () => {
  it("executes shutdown sequence in order", async () => {
    const order: string[] = [];

    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {
          order.push("stop");
        },
        onDrainAgents: async () => {
          order.push("drain");
        },
        onCleanup: async () => {
          order.push("cleanup");
        },
      },
      mock(() => {}),
    );

    await handler.shutdown();

    expect(order).toEqual(["stop", "drain", "cleanup"]);
  });

  it("is idempotent — second call is a no-op", async () => {
    const drainCount = mock(() => Promise.resolve());
    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {},
        onDrainAgents: drainCount,
        onCleanup: async () => {},
      },
      mock(() => {}),
    );

    await handler.shutdown();
    await handler.shutdown();

    expect(drainCount).toHaveBeenCalledTimes(1);
  });

  it("reports isShuttingDown correctly", async () => {
    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {},
        onDrainAgents: async () => {},
        onCleanup: async () => {},
      },
      mock(() => {}),
    );

    expect(handler.isShuttingDown()).toBe(false);
    await handler.shutdown();
    expect(handler.isShuttingDown()).toBe(true);
  });

  it("emits shutdown_started and shutdown_complete events", async () => {
    const events: string[] = [];
    const emit = mock((type: string) => {
      events.push(type);
    });

    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {},
        onDrainAgents: async () => {},
        onCleanup: async () => {},
      },
      emit,
    );

    await handler.shutdown();

    expect(events).toContain("shutdown_started");
    expect(events).toContain("shutdown_complete");
  });

  it("times out slow drain", async () => {
    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {},
        onDrainAgents: () =>
          new Promise((resolve) => {
            setTimeout(resolve, 10_000); // Very slow drain
          }),
        onCleanup: async () => {},
      },
      mock(() => {}),
      100, // 100ms timeout
    );

    const start = Date.now();
    await handler.shutdown();
    const elapsed = Date.now() - start;

    // Should complete within timeout + some margin, not wait for 10s
    expect(elapsed).toBeLessThan(500);
  });

  it("installs and uninstalls signal handlers", () => {
    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {},
        onDrainAgents: async () => {},
        onCleanup: async () => {},
      },
      mock(() => {}),
    );

    // Should not throw
    handler.install();
    handler.uninstall();
  });

  it("runs cleanup even when onDrainAgents rejects", async () => {
    const order: string[] = [];
    const events: string[] = [];

    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {
          order.push("stop");
        },
        onDrainAgents: async () => {
          order.push("drain");
          throw new Error("drain exploded");
        },
        onCleanup: async () => {
          order.push("cleanup");
        },
      },
      (type: string) => {
        events.push(type);
      },
    );

    await handler.shutdown();

    expect(order).toEqual(["stop", "drain", "cleanup"]);
    expect(events).toContain("shutdown_started");
    expect(events).toContain("shutdown_error");
    expect(events).toContain("shutdown_complete");
  });

  it("emits shutdown_complete even when onCleanup rejects", async () => {
    const events: string[] = [];

    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {},
        onDrainAgents: async () => {},
        onCleanup: async () => {
          throw new Error("cleanup exploded");
        },
      },
      (type: string) => {
        events.push(type);
      },
    );

    await handler.shutdown();

    expect(events).toContain("shutdown_complete");
    expect(events.filter((e) => e === "shutdown_error")).toHaveLength(1);
  });

  it("install is idempotent — repeated calls do not leak listeners", () => {
    const handler = createShutdownHandler(
      {
        onStopAccepting: () => {},
        onDrainAgents: async () => {},
        onCleanup: async () => {},
      },
      mock(() => {}),
    );

    const before = process.listenerCount("SIGTERM");
    handler.install();
    const afterFirst = process.listenerCount("SIGTERM");
    handler.install(); // second call should be a no-op
    const afterSecond = process.listenerCount("SIGTERM");

    expect(afterFirst - before).toBe(1);
    expect(afterSecond).toBe(afterFirst);

    handler.uninstall();
  });
});
