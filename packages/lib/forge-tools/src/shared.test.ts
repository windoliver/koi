import { describe, expect, test } from "bun:test";
import type { BrickKind, ForgeScope } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import type { ToolExecutionContext } from "@koi/execution-context";
import { runWithExecutionContext } from "@koi/execution-context";
import { computeIdentityBrickId, type IdentityInputs, resolveCaller } from "./shared.js";

const baseTool: IdentityInputs = {
  kind: "tool" satisfies BrickKind,
  name: "add-numbers",
  description: "Add two numbers and return the sum.",
  version: "0.0.1",
  scope: "agent" satisfies ForgeScope,
  ownerAgentId: "agent-A",
  content: { implementation: "return a + b;", inputSchema: { type: "object" } },
};

describe("computeIdentityBrickId", () => {
  test("same inputs produce same id (deterministic)", () => {
    expect(computeIdentityBrickId(baseTool)).toBe(computeIdentityBrickId(baseTool));
  });

  test("different ownerAgentId → different id (per-publisher partitioning)", () => {
    const a = computeIdentityBrickId(baseTool);
    const b = computeIdentityBrickId({ ...baseTool, ownerAgentId: "agent-B" });
    expect(a).not.toBe(b);
  });

  test("different scope → different id", () => {
    const a = computeIdentityBrickId(baseTool);
    const b = computeIdentityBrickId({ ...baseTool, scope: "global" });
    expect(a).not.toBe(b);
  });

  test("different content → different id", () => {
    const a = computeIdentityBrickId(baseTool);
    const b = computeIdentityBrickId({
      ...baseTool,
      content: { implementation: "return a - b;", inputSchema: { type: "object" } },
    });
    expect(a).not.toBe(b);
  });

  test("id matches the canonical sha256:<64-hex> shape", () => {
    expect(computeIdentityBrickId(baseTool)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("resolveCaller", () => {
  test("returns agentId from active execution context", () => {
    const ctx: ToolExecutionContext = {
      session: {
        agentId: "agent-X",
        sessionId: sessionId("s1"),
        runId: runId("r1"),
        metadata: {},
      },
      turnIndex: 0,
    };
    const got = runWithExecutionContext(ctx, () => resolveCaller());
    expect(got).toEqual({ agentId: "agent-X" });
  });

  test("throws NO_CONTEXT when called outside any context", () => {
    expect(() => resolveCaller()).toThrow(/NO_CONTEXT/);
  });
});
