import { describe, expect, test } from "bun:test";
import { type Agent, agentId, toolToken } from "@koi/core";
import { createHandoffProvider } from "./provider.js";
import { createInMemoryHandoffStore } from "./store.js";

const fakeAgent = {} as Agent;

describe("createHandoffProvider", () => {
  test("attaches both prepare_handoff and accept_handoff tools", async () => {
    const store = createInMemoryHandoffStore();
    const provider = createHandoffProvider({ store, agentId: agentId("a") });
    const result = await provider.attach(fakeAgent);
    const map = result instanceof Map ? result : (result as ReadonlyMap<string, unknown>);
    expect(map.has(toolToken("prepare_handoff") as string)).toBe(true);
    expect(map.has(toolToken("accept_handoff") as string)).toBe(true);
  });

  test("attach is idempotent", async () => {
    const store = createInMemoryHandoffStore();
    const provider = createHandoffProvider({ store, agentId: agentId("a") });
    const a = await provider.attach(fakeAgent);
    const b = await provider.attach(fakeAgent);
    expect(a).toBe(b);
  });
});
