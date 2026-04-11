import { describe, expect, test } from "bun:test";
import type { ConfigReloadEvent } from "./events.js";
import { createConfigEventBus } from "./events.js";
import { DEFAULT_KOI_CONFIG } from "./reload.js";

describe("createConfigEventBus", () => {
  test("notify delivers events to subscribers synchronously", () => {
    const bus = createConfigEventBus();
    const received: ConfigReloadEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.notify({ kind: "attempted", filePath: "/tmp/x.yaml" });

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("attempted");
  });

  test("unsubscribe stops delivery", () => {
    const bus = createConfigEventBus();
    const received: ConfigReloadEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));
    bus.notify({ kind: "attempted", filePath: "/tmp/x.yaml" });
    unsub();
    bus.notify({ kind: "attempted", filePath: "/tmp/y.yaml" });
    expect(received).toHaveLength(1);
  });

  test("multiple subscribers each receive the event", () => {
    const bus = createConfigEventBus();
    const a: ConfigReloadEvent[] = [];
    const b: ConfigReloadEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.notify({ kind: "attempted", filePath: "/tmp/x.yaml" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("exception in one listener does not break others", () => {
    const bus = createConfigEventBus();
    const received: ConfigReloadEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => received.push(e));
    bus.notify({ kind: "attempted", filePath: "/tmp/x.yaml" });
    expect(received).toHaveLength(1);
  });

  test("applied event carries full change payload", () => {
    const bus = createConfigEventBus();
    const received: ConfigReloadEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const prev = DEFAULT_KOI_CONFIG;
    const next = { ...DEFAULT_KOI_CONFIG, logLevel: "debug" as const };
    bus.notify({
      kind: "applied",
      filePath: "/tmp/x.yaml",
      prev,
      next,
      changedPaths: ["logLevel"],
    });

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event?.kind).toBe("applied");
    if (event?.kind === "applied") {
      expect(event.changedPaths).toEqual(["logLevel"]);
      expect(event.next.logLevel).toBe("debug");
    }
  });

  test("rejected event carries reason and optional restart paths", () => {
    const bus = createConfigEventBus();
    const received: ConfigReloadEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.notify({
      kind: "rejected",
      filePath: "/tmp/x.yaml",
      reason: "restart-required",
      error: {
        code: "VALIDATION",
        message: "needs restart",
        retryable: false,
      },
      restartRequiredPaths: ["limits"],
    });

    const event = received[0];
    expect(event?.kind).toBe("rejected");
    if (event?.kind === "rejected") {
      expect(event.reason).toBe("restart-required");
      expect(event.restartRequiredPaths).toEqual(["limits"]);
    }
  });
});
