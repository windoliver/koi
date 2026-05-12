import { describe, expect, test } from "bun:test";
import { createCachedBridge } from "./cached-bridge.js";

interface FakeLease {
  readonly execute: (payload: string) => Promise<string>;
  readonly dispose: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createCachedBridge", () => {
  test("acquires only once for concurrent callers and reuses the lease", async () => {
    let acquireCalls = 0;
    const bridge = createCachedBridge<string, string>({
      ttlMs: 1_000,
      acquire: async () => {
        acquireCalls += 1;
        return {
          execute: async (payload: string) => `lease-${acquireCalls}:${payload}`,
          dispose: async () => undefined,
        };
      },
    });

    const [first, second] = await Promise.all([bridge.execute("a"), bridge.execute("b")]);

    expect(first).toBe("lease-1:a");
    expect(second).toBe("lease-1:b");
    expect(acquireCalls).toBe(1);

    await bridge.dispose();
  });

  test("reacquires after ttl expiry and disposes the expired lease", async () => {
    const disposed: number[] = [];
    let acquireCalls = 0;
    const bridge = createCachedBridge<string, string>({
      ttlMs: 10,
      acquire: async () => {
        acquireCalls += 1;
        const id = acquireCalls;
        return {
          execute: async (payload: string) => `lease-${id}:${payload}`,
          dispose: async () => {
            disposed.push(id);
          },
        };
      },
    });

    expect(await bridge.execute("now")).toBe("lease-1:now");
    await sleep(20);
    expect(await bridge.execute("later")).toBe("lease-2:later");

    expect(acquireCalls).toBe(2);
    expect(disposed).toEqual([1]);

    await bridge.dispose();
    expect(disposed).toEqual([1, 2]);
  });

  test("dispose waits for in-flight acquisition and late lease cleanup", async () => {
    let resolveAcquire: ((lease: FakeLease) => void) | undefined;
    let releaseCleanup: (() => void) | undefined;
    const events: string[] = [];

    const bridge = createCachedBridge<string, string>({
      ttlMs: 1_000,
      acquire: () =>
        new Promise<FakeLease>((resolve) => {
          resolveAcquire = resolve;
        }),
    });

    const warmupPromise = bridge.warmup();
    const disposePromise = bridge.dispose().then(() => {
      events.push("dispose:done");
    });

    expect(events).toEqual([]);

    resolveAcquire?.({
      execute: async (payload: string) => payload,
      dispose: async () => {
        events.push("lease:dispose:start");
        await new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
        events.push("lease:dispose:end");
      },
    });

    await sleep(0);
    expect(events).toEqual(["lease:dispose:start"]);

    releaseCleanup?.();

    await expect(warmupPromise).rejects.toThrow(/disposed/i);
    await disposePromise;
    expect(events).toEqual(["lease:dispose:start", "lease:dispose:end", "dispose:done"]);
  });
});
