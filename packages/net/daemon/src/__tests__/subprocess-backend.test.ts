import { describe, expect, it } from "bun:test";
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

    // Each worker must be gone from backend state — watch() returns
    // immediately with no events for a pruned id.
    for (let i = 0; i < 5; i++) {
      const id = workerId(`churn-${i}`);
      expect(await backend.isAlive(id)).toBe(false);
      const events: string[] = [];
      for await (const ev of backend.watch(id)) {
        events.push(ev.kind);
      }
      // Pruned: watch() for a missing id returns nothing. A retained (leaked)
      // dead worker would yield its buffered started+exited events.
      expect(events).toEqual([]);
    }
  });
});
