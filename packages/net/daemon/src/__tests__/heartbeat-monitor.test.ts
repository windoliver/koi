import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentId, WorkerEvent, WorkerId } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createHeartbeatMonitor, type HeartbeatMonitor } from "../heartbeat-monitor.js";

const wid = (s: string): WorkerId => workerId(s);
const aid = (s: string): AgentId => agentId(s);
const CONFIG = { intervalMs: 50, timeoutMs: 120 };

interface Harness {
  readonly monitor: HeartbeatMonitor;
  readonly events: WorkerEvent[];
  readonly teardownCalls: Array<{ readonly id: WorkerId; readonly reason: string }>;
  tick: (ms: number) => Promise<void>;
}

const makeHarness = (opts?: {
  readonly teardownImpl?: (id: WorkerId, reason: string) => Promise<void>;
}): Harness => {
  const events: WorkerEvent[] = [];
  const teardownCalls: Array<{ readonly id: WorkerId; readonly reason: string }> = [];
  let nowMs = 1_000_000;
  const monitor = createHeartbeatMonitor({
    publishEvent: (ev) => events.push(ev),
    teardown: async (id, reason) => {
      teardownCalls.push({ id, reason });
      if (opts?.teardownImpl !== undefined) await opts.teardownImpl(id, reason);
    },
    now: () => nowMs,
  });
  return {
    monitor,
    events,
    teardownCalls,
    tick: async (ms: number) => {
      nowMs += ms;
      await new Promise((r) => setTimeout(r, ms));
    },
  };
};

describe("createHeartbeatMonitor", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.monitor.shutdown();
  });

  it("track arms a deadline timer — timeout fires after timeoutMs with no observe", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls.map((c) => c.id)).toContain(wid("w1"));
    const crash = h.events.find((e) => e.kind === "crashed" && e.workerId === wid("w1")) as
      | { kind: "crashed"; error: { code: string } }
      | undefined;
    expect(crash).toBeDefined();
    expect(crash?.error.code).toBe("HEARTBEAT_TIMEOUT");
  });

  it("observe resets deadline — no timeout if called within window", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(CONFIG.timeoutMs - 20);
    h.monitor.observe(wid("w1"));
    await h.tick(CONFIG.timeoutMs - 20);
    h.monitor.observe(wid("w1"));
    await h.tick(CONFIG.timeoutMs - 20);
    expect(h.teardownCalls).toEqual([]);
    expect(h.events.filter((e) => e.kind === "crashed")).toEqual([]);
  });

  it("untrack clears timer — no fire after untrack", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    h.monitor.untrack(wid("w1"));
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls).toEqual([]);
    expect(h.events.filter((e) => e.kind === "crashed")).toEqual([]);
  });

  it("shutdown clears every tracked timer", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    h.monitor.track(wid("w2"), aid("a2"), CONFIG);
    h.monitor.shutdown();
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls).toEqual([]);
  });

  it("timeout teardown reason is 'heartbeat-timeout'", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls[0]?.reason).toBe("heartbeat-timeout");
  });

  it("snapshot returns current state for each tracked worker", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    h.monitor.track(wid("w2"), aid("a2"), CONFIG);
    h.monitor.observe(wid("w1"));
    const snap = h.monitor.snapshot();
    expect(snap).toHaveLength(2);
    const w1 = snap.find((s) => s.workerId === wid("w1"));
    expect(w1?.agentId).toBe(aid("a1"));
    expect(w1?.state).toBe("running");
    expect(typeof w1?.lastHeartbeatAt).toBe("number");
    expect(typeof w1?.heartbeatDeadlineAt).toBe("number");
  });

  it("double track on same id replaces state (old timer cleared)", async () => {
    h.monitor.track(wid("w1"), aid("a1"), { intervalMs: 10, timeoutMs: 40 });
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(60);
    expect(h.teardownCalls).toEqual([]);
  });

  it("observe on untracked id is a no-op", () => {
    expect(() => h.monitor.observe(wid("never-tracked"))).not.toThrow();
  });

  it("untrack on untracked id is a no-op", () => {
    expect(() => h.monitor.untrack(wid("never-tracked"))).not.toThrow();
  });

  it("teardown rejection is swallowed — does not throw into event loop", async () => {
    const bad = makeHarness({
      teardownImpl: () => Promise.reject(new Error("teardown boom")),
    });
    bad.monitor.track(wid("w1"), aid("a1"), CONFIG);
    const captured = mock(() => undefined);
    const orig = process.listeners("unhandledRejection");
    const handler = (): void => captured();
    process.on("unhandledRejection", handler);
    try {
      await bad.tick(CONFIG.timeoutMs + 30);
      await new Promise((r) => setTimeout(r, 20));
      expect(captured).toHaveBeenCalledTimes(0);
    } finally {
      process.off("unhandledRejection", handler);
      for (const l of orig) process.on("unhandledRejection", l);
      bad.monitor.shutdown();
    }
  });
});
