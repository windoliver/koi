import { describe, expect, it } from "bun:test";
import type { WorkerEvent } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createSubprocessBackend } from "../subprocess-backend.js";

const HEARTBEAT_CHILD = `
setInterval(() => {
  if (typeof process.send === "function") process.send({ koi: "heartbeat" });
}, 30);
setTimeout(() => process.exit(0), 500);
`;

const NO_HEARTBEAT_CHILD = `
setTimeout(() => process.exit(0), 500);
`;

const collect = async (
  iter: AsyncIterable<WorkerEvent>,
  stopPredicate: (ev: WorkerEvent) => boolean,
  timeoutMs = 1_000,
): Promise<readonly WorkerEvent[]> => {
  const out: WorkerEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const ev of iter) {
    out.push(ev);
    if (stopPredicate(ev)) break;
    if (Date.now() > deadline) break;
  }
  return out;
};

describe("subprocess heartbeat (IPC opt-in)", () => {
  it("emits heartbeat WorkerEvent when child sends {koi:'heartbeat'} via process.send", async () => {
    const backend = createSubprocessBackend();
    const id = workerId("ipc-hb-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-ipc-hb-1"),
      command: ["bun", "-e", HEARTBEAT_CHILD],
      backendHints: { heartbeat: true },
    });
    expect(spawned.ok).toBe(true);
    const events = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    const heartbeats = events.filter((e) => e.kind === "heartbeat");
    expect(heartbeats.length).toBeGreaterThan(0);
  });

  it("does NOT attach IPC handler when backendHints.heartbeat is absent", async () => {
    const backend = createSubprocessBackend();
    const id = workerId("no-ipc-hb-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-no-ipc-hb-1"),
      command: ["bun", "-e", HEARTBEAT_CHILD],
    });
    expect(spawned.ok).toBe(true);
    const events = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    const heartbeats = events.filter((e) => e.kind === "heartbeat");
    expect(heartbeats.length).toBe(0);
  });

  it("heartbeat event retention is bounded — replay buffer does not grow with heartbeat count", async () => {
    // Regression for unbounded state.events growth: a long-lived worker
    // sending heartbeats every tick used to push each into the replay
    // buffer. After the fix, heartbeats dispatch to active listeners
    // only and do NOT accumulate. We verify by letting heartbeats flow
    // for a while, then attaching a SECOND watcher late — that watcher
    // should NOT receive any historical heartbeats, only started (and
    // eventually the terminal event).
    const backend = createSubprocessBackend();
    const id = workerId("hb-bounded-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-hb-bounded-1"),
      command: ["bun", "-e", HEARTBEAT_CHILD],
      backendHints: { heartbeat: true },
    });
    expect(spawned.ok).toBe(true);
    // Let the child send a bunch of heartbeats without an active watcher.
    // Without the fix, these would pile up in state.events.
    await new Promise((r) => setTimeout(r, 300));
    const replay = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    // The replay should start with `started` (buffered) and proceed into
    // LIVE heartbeats arriving after the watcher attached — never into
    // historical heartbeats from before the attach. We can't easily
    // distinguish replay vs live events, but we CAN prove the buffer
    // didn't hold ~10 pre-attach heartbeats: the first heartbeat the
    // watcher sees should have a timestamp AFTER the attach moment
    // (since buffered heartbeats were dropped).
    const startedIdx = replay.findIndex((e) => e.kind === "started");
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    // If heartbeats were buffered, many would precede any live emit.
    // After the fix, heartbeats only show up after the attach.
    const heartbeats = replay.filter((e) => e.kind === "heartbeat");
    // Child emits at 30ms intervals; we waited 300ms pre-attach. Buffered
    // behavior would surface ~10 historical heartbeats (roughly 300/30).
    // After the fix, we see fewer than the pre-attach count because the
    // pre-attach ones were dropped — the test remains stable even on a
    // slow runner because we only bound the upper count, not lower.
    expect(heartbeats.length).toBeLessThan(10);
  });

  it("child that never heartbeats still exits cleanly under IPC opt-in (backend is permissive)", async () => {
    const backend = createSubprocessBackend();
    const id = workerId("silent-hb-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-silent-hb-1"),
      command: ["bun", "-e", NO_HEARTBEAT_CHILD],
      backendHints: { heartbeat: true },
    });
    expect(spawned.ok).toBe(true);
    const events = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    expect(events.some((e) => e.kind === "exited")).toBe(true);
    expect(events.filter((e) => e.kind === "heartbeat").length).toBe(0);
  });
});
