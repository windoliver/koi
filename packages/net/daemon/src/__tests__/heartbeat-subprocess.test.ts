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
  const iterator = iter[Symbol.asyncIterator]();
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Race each iterator.next() against the remaining deadline. Without
      // this, a stalled iterator (terminal event dropped, producer hung)
      // keeps the for-await blocked indefinitely — the test then only
      // fails at the global test timeout with no signal about the race.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedNext = Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          timer = setTimeout(() => resolve({ done: true, value: undefined }), remaining);
        }),
      ]);
      const r = await timedNext;
      clearTimeout(timer);
      if (r.done) break;
      out.push(r.value);
      if (stopPredicate(r.value)) break;
    }
  } finally {
    if (iterator.return !== undefined) await iterator.return(undefined);
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

  it("terminal event is NOT lost when worker exits during heartbeat-replay yield pause", async () => {
    // Regression: after yielding the replayed heartbeat, the watcher
    // checked state.alive and returned early. If the subprocess exited
    // BETWEEN the heartbeat yield and the alive check, the buffered
    // exited event was silently dropped — consumers got `started`,
    // `heartbeat`, then iterator done with no terminal. Fix: re-drain
    // state.events after the heartbeat yield.
    //
    // We reproduce by spawning a quickly-exiting child that still emits
    // a heartbeat beforehand, consuming slowly (small per-event delay),
    // and asserting the terminal event is the last thing yielded.
    const backend = createSubprocessBackend();
    const id = workerId("hb-terminal-race-1");
    const QUICK_HEARTBEAT_THEN_EXIT = `
      if (typeof process.send === "function") process.send({ koi: "heartbeat" });
      setTimeout(() => process.exit(0), 50);
    `;
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-hb-terminal-race-1"),
      command: ["bun", "-e", QUICK_HEARTBEAT_THEN_EXIT],
      backendHints: { heartbeat: true },
    });
    expect(spawned.ok).toBe(true);
    // Wait long enough that `started` + heartbeat are buffered AND the
    // subprocess has exited (so exited event is in state.events).
    await new Promise((r) => setTimeout(r, 200));
    const events: WorkerEvent[] = [];
    for await (const ev of backend.watch(id)) {
      events.push(ev);
      // Simulate a slow consumer. Terminal event must still be delivered.
      await new Promise((r) => setTimeout(r, 5));
      if (ev.kind === "exited" || ev.kind === "crashed") break;
    }
    const terminal = events[events.length - 1];
    expect(terminal).toBeDefined();
    expect(terminal?.kind === "exited" || terminal?.kind === "crashed").toBe(true);
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
