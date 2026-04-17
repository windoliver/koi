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
