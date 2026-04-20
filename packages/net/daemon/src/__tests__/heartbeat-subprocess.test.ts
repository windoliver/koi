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

  it("heartbeat event retention is bounded — at most one pre-attach heartbeat is replayed (latest wins)", async () => {
    // Regression for unbounded state.events growth. The invariant:
    // lifecycle events (started, exited, crashed) are always buffered
    // for late-attaching watchers, but heartbeats collapse to a single
    // lastHeartbeat slot. So a watcher that attaches late sees:
    //   1. `started` (from buffer)
    //   2. AT MOST ONE pre-attach heartbeat (the latest — for liveness)
    //   3. 0+ post-attach heartbeats (live)
    //   4. terminal event
    //
    // Without the fix, state.events would grow with every heartbeat and
    // the watcher would see N pre-attach heartbeats (bounded by emit
    // count). With the fix, the watcher sees <= 1 pre-attach heartbeat
    // regardless of how many the child emitted.
    //
    // We assert by counting heartbeats with timestamps strictly BEFORE
    // the attach moment. If buffer is bounded, the count is 0 or 1.
    const backend = createSubprocessBackend();
    const id = workerId("hb-bounded-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-hb-bounded-1"),
      command: ["bun", "-e", HEARTBEAT_CHILD],
      backendHints: { heartbeat: true },
    });
    expect(spawned.ok).toBe(true);
    // Let the child send ~10 heartbeats (30ms interval × 300ms wait).
    // Without the fix, all 10 would sit in state.events; with the fix,
    // only the most recent is retained in state.lastHeartbeat.
    await new Promise((r) => setTimeout(r, 300));
    const attachAt = Date.now();
    const replay = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    // Every pre-attach heartbeat has .at < attachAt. Bounded-buffer
    // means 0 or 1 such events (the last-heartbeat slot). Unbounded
    // would surface ~10.
    const preAttachHeartbeats = replay.filter((e) => e.kind === "heartbeat" && e.at < attachAt);
    expect(preAttachHeartbeats.length).toBeLessThanOrEqual(1);
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
