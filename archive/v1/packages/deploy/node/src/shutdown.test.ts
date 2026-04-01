/**
 * Shutdown tests — validates @koi/shutdown re-export works correctly from @koi/node.
 */
import { describe, expect, it, mock } from "bun:test";
import { createShutdownHandler } from "./shutdown.js";

describe("ShutdownHandler (re-exported from @koi/shutdown)", () => {
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
});
