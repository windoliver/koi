import { describe, expect, test } from "bun:test";
import { type Agent, type TaskableAgent, toolToken } from "@koi/core";
import { createTaskSpawnProvider } from "./provider.js";

const agent: TaskableAgent = {
  name: "researcher",
  description: "Research agent",
  manifest: { name: "researcher", version: "1.0.0", model: { name: "m" } },
};

const fakeAgent = {} as Agent;

describe("createTaskSpawnProvider", () => {
  test("attaches tool:task", async () => {
    const provider = createTaskSpawnProvider({
      agents: new Map([["researcher", agent]]),
      spawn: async () => ({ ok: true, output: "" }),
    });
    const result = await provider.attach(fakeAgent);
    const map = result instanceof Map ? result : (result as ReadonlyMap<string, unknown>);
    expect(map.has(toolToken("task") as string)).toBe(true);
  });

  test("attach is idempotent", async () => {
    const provider = createTaskSpawnProvider({
      agents: new Map([["researcher", agent]]),
      spawn: async () => ({ ok: true, output: "" }),
    });
    const a = await provider.attach(fakeAgent);
    const b = await provider.attach(fakeAgent);
    expect(a).toBe(b);
  });
});
