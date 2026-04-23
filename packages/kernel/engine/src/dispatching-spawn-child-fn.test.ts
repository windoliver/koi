import { describe, expect, it } from "bun:test";
import type { AgentManifest, ChildSpec } from "@koi/core";
import { agentId } from "@koi/core";
import { createDispatchingSpawnChildFn } from "./dispatching-spawn-child-fn.js";

const MANIFEST: AgentManifest = {
  name: "w",
  version: "1.0.0",
  model: { name: "test-model" },
};

describe("createDispatchingSpawnChildFn", () => {
  it("routes in-process children to the inProcess adapter", async () => {
    const calls: string[] = [];
    const inProcess = async (): Promise<ReturnType<typeof agentId>> => {
      calls.push("in-process");
      return agentId("child-inp");
    };
    const subprocess = async (): Promise<ReturnType<typeof agentId>> => {
      calls.push("subprocess");
      return agentId("child-sub");
    };
    const dispatch = createDispatchingSpawnChildFn({ inProcess, subprocess });

    const spec: ChildSpec = { name: "c", restart: "permanent", isolation: "in-process" };
    const out = await dispatch(agentId("p"), spec, MANIFEST);
    expect(out).toBe(agentId("child-inp"));
    expect(calls).toEqual(["in-process"]);
  });

  it("routes subprocess children to the subprocess adapter", async () => {
    const calls: string[] = [];
    const inProcess = async (): Promise<ReturnType<typeof agentId>> => {
      calls.push("in-process");
      return agentId("child-inp");
    };
    const subprocess = async (): Promise<ReturnType<typeof agentId>> => {
      calls.push("subprocess");
      return agentId("child-sub");
    };
    const dispatch = createDispatchingSpawnChildFn({ inProcess, subprocess });

    const spec: ChildSpec = { name: "c", restart: "permanent", isolation: "subprocess" };
    const out = await dispatch(agentId("p"), spec, MANIFEST);
    expect(out).toBe(agentId("child-sub"));
    expect(calls).toEqual(["subprocess"]);
  });

  it("defaults to in-process when isolation is omitted", async () => {
    let hit: string | undefined;
    const dispatch = createDispatchingSpawnChildFn({
      inProcess: async () => {
        hit = "in-process";
        return agentId("x");
      },
      subprocess: async () => {
        hit = "subprocess";
        return agentId("y");
      },
    });
    const spec: ChildSpec = { name: "c", restart: "permanent" };
    await dispatch(agentId("p"), spec, MANIFEST);
    expect(hit).toBe("in-process");
  });

  it("throws when a subprocess child arrives without a subprocess adapter", () => {
    const dispatch = createDispatchingSpawnChildFn({
      inProcess: async () => agentId("x"),
    });
    const spec: ChildSpec = { name: "c", restart: "permanent", isolation: "subprocess" };
    expect(() => dispatch(agentId("p"), spec, MANIFEST)).toThrow(/no subprocess adapter/);
  });
});
