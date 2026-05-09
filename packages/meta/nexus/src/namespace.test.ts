import { describe, expect, test } from "bun:test";
import { computeAgentNamespace, computeGroupNamespace } from "./namespace.js";

describe("namespace helpers", () => {
  test("computes stable agent namespaces from agent id", () => {
    const ns = computeAgentNamespace("agent-123");
    expect(ns.filesystem).toBe("agents/agent-123/filesystem");
    expect(ns.mailbox).toBe("agents/agent-123/mailbox");
    expect(ns.snapshotStore).toBe("agents/agent-123/snapshots");
    expect(ns.playbooks).toBe("agents/agent-123/playbooks");
    expect(ns.handoffs).toBe("agents/agent-123/handoffs");
  });

  test("computes stable group scratchpad namespace from group id", () => {
    expect(computeGroupNamespace("team-7").scratchpad).toBe("groups/team-7/scratchpad");
  });
});
