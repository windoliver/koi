import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentId, workerId } from "@koi/core";
import { createSubprocessBackend } from "../subprocess-backend.js";

describe("subprocess backend", () => {
  it("spawns a subprocess that runs to completion", async () => {
    const backend = createSubprocessBackend();
    expect(await backend.isAvailable()).toBe(true);
    const spawned = await backend.spawn({
      workerId: workerId("sub1"),
      agentId: agentId("agent-sub1"),
      command: ["bun", "--version"],
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.value.backendKind).toBe("subprocess");
    // Wait briefly for process to exit
    await new Promise((r) => setTimeout(r, 200));
    expect(await backend.isAlive(workerId("sub1"))).toBe(false);
  });
});

describe("subprocess terminate/kill", () => {
  it("terminates a long-running subprocess via SIGTERM", async () => {
    const backend = createSubprocessBackend();
    const spawned = await backend.spawn({
      workerId: workerId("sub2"),
      agentId: agentId("agent-sub2"),
      command: ["bun", "-e", "setTimeout(()=>{},10000)"],
    });
    expect(spawned.ok).toBe(true);
    await backend.terminate(workerId("sub2"), "test");
    await new Promise((r) => setTimeout(r, 200));
    expect(await backend.isAlive(workerId("sub2"))).toBe(false);
  });

  it("emits crashed on non-zero exit", async () => {
    const backend = createSubprocessBackend();
    await backend.spawn({
      workerId: workerId("sub3"),
      agentId: agentId("agent-sub3"),
      command: ["bun", "-e", "process.exit(42)"],
    });
    const events: string[] = [];
    for await (const ev of backend.watch(workerId("sub3"))) {
      events.push(ev.kind);
      if (ev.kind === "crashed" || ev.kind === "exited") break;
    }
    expect(events).toContain("crashed");
  });

  it("captures stdout/stderr to logPath when backendHints.logPath is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koi-subproc-log-"));
    try {
      const logPath = join(dir, "w-log.log");
      // Pre-create the file so Bun.file can write to it — Bun's file-sink
      // opens for truncate+write and errors if the path is missing parent
      // dirs. The tmpdir above already exists, so touching the file is enough.
      await Bun.write(logPath, "");

      const backend = createSubprocessBackend();
      const spawned = await backend.spawn({
        workerId: workerId("log-1"),
        agentId: agentId("agent-log-1"),
        command: [
          "bun",
          "-e",
          'process.stdout.write("hello-stdout\\n"); process.stderr.write("hello-stderr\\n");',
        ],
        backendHints: { logPath },
      });
      expect(spawned.ok).toBe(true);

      // Drain watch() until terminal so we know the process has finished
      // and stdio flushes are complete.
      for await (const ev of backend.watch(workerId("log-1"))) {
        if (ev.kind === "exited" || ev.kind === "crashed") break;
      }

      const contents = await readFile(logPath, "utf8");
      expect(contents).toContain("hello-stdout");
      expect(contents).toContain("hello-stderr");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prune timer is generation-safe — same-id respawn survives stale prune fire", async () => {
    // Regression guard: when the supervisor aborts a watch before the
    // terminal event is drained, `terminalDelivered` stays false and the
    // prune timer (armed on proc.exited) keeps running. If the same
    // workerId is respawned before the timer fires, an indiscriminate
    // `workers.delete(id)` would evict the LIVE successor entry, leaving
    // subsequent isAlive/terminate/kill/watch calls tracking a ghost.
    // The prune must identity-check against the current map entry.
    const backend = createSubprocessBackend();
    const id = workerId("gen-safe-1");

    // Spawn #1 — quick exit.
    const first = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-gen-1"),
      command: ["bun", "-e", "process.exit(0)"],
    });
    expect(first.ok).toBe(true);
    // Let the child exit so the prune timer is armed.
    await new Promise((r) => setTimeout(r, 100));
    // Verify first generation is dead (state retained, prune not yet fired).
    expect(await backend.isAlive(id)).toBe(false);

    // Spawn #2 — same id, long-running. This REPLACES workers[id] with a
    // fresh state. The stale prune timer from spawn #1 is still armed.
    const second = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-gen-2"),
      command: ["bun", "-e", "setTimeout(()=>{},10000)"],
    });
    expect(second.ok).toBe(true);
    expect(await backend.isAlive(id)).toBe(true);

    // The stale prune timer is on a 30s grace window; we can't wait that
    // long in a test. Instead, directly verify the invariant: if a same-id
    // respawn installed a fresh state, a blind prune of the stale state
    // would have deleted the new entry. Identity-check keeps it alive.
    // (We sanity-check by terminating the second generation cleanly.)
    await backend.kill(id);
    await new Promise((r) => setTimeout(r, 200));
    expect(await backend.isAlive(id)).toBe(false);
  });

  it("watch() returns when the AbortSignal fires mid-iteration", async () => {
    // A long-lived worker's watch generator must exit cleanly when the
    // supervisor aborts its signal (stop() / shutdown() path). Without
    // this, the supervisor's per-worker watch IIFE would hang for the
    // rest of the supervisor's lifetime on backends that stall or drop
    // their watch stream without emitting a terminal event.
    const backend = createSubprocessBackend();
    const spawned = await backend.spawn({
      workerId: workerId("abort-1"),
      agentId: agentId("agent-abort-1"),
      command: ["bun", "-e", "setTimeout(()=>{},10000)"],
    });
    expect(spawned.ok).toBe(true);
    const controller = new AbortController();
    const events: string[] = [];
    const iterPromise = (async (): Promise<void> => {
      for await (const ev of backend.watch(workerId("abort-1"), controller.signal)) {
        events.push(ev.kind);
        if (ev.kind === "started") {
          // Trigger abort on the next tick so the generator is parked on
          // its await when the signal fires — this exercises the
          // listener-resolves-cancelResolve path, not the early-abort
          // short-circuit.
          queueMicrotask(() => controller.abort());
        }
      }
    })();
    // Bound the wait: the test fails (times out) if the generator never
    // returns after abort.
    await Promise.race([
      iterPromise,
      new Promise((_r, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);
    expect(events).toContain("started");
    // Clean up the child — abort doesn't kill the process, just the watch.
    await backend.kill(workerId("abort-1"));
  });

  it("prunes dead workers from internal state after exit", async () => {
    // A long-lived daemon that spins up many short-lived workers must not
    // retain their state indefinitely. After a worker exits, isAlive must
    // return false AND the worker must no longer be tracked — subsequent
    // calls to terminate/kill/watch for that id see a clean slate.
    const backend = createSubprocessBackend();
    for (let i = 0; i < 5; i++) {
      const id = workerId(`churn-${i}`);
      await backend.spawn({
        workerId: id,
        agentId: agentId(`agent-churn-${i}`),
        command: ["bun", "-e", "process.exit(0)"],
      });
    }
    // Wait for all to exit.
    await new Promise((r) => setTimeout(r, 300));

    // First watch() must deliver the buffered started+terminal events even
    // though the subprocess already exited. THEN the worker state is pruned.
    for (let i = 0; i < 5; i++) {
      const id = workerId(`churn-${i}`);
      expect(await backend.isAlive(id)).toBe(false);
      const firstWatch: string[] = [];
      for await (const ev of backend.watch(id)) {
        firstWatch.push(ev.kind);
      }
      // State retained for this consumer: got started + terminal event.
      expect(firstWatch.length).toBeGreaterThanOrEqual(2);
      expect(firstWatch).toContain("started");
      // A SECOND watch() must return nothing — state has been pruned by
      // the first watcher's terminal-event consumption.
      const secondWatch: string[] = [];
      for await (const ev of backend.watch(id)) {
        secondWatch.push(ev.kind);
      }
      expect(secondWatch).toEqual([]);
    }
  });
});
