import { describe, expect, it } from "bun:test";
import { agentId, type JsonObject } from "@koi/core";
import type {
  AliasSpec,
  ApprovalQuery,
  ApprovalScope,
  ApprovalStore,
  PersistedApproval,
} from "./types.js";

describe("types.ts", () => {
  it("ApprovalScope is the narrow string union", () => {
    const values: readonly ApprovalScope[] = ["once", "session", "always"];
    expect(values).toEqual(["once", "session", "always"]);
  });

  it("PersistedApproval has all required fields including agentId scope", () => {
    const g: PersistedApproval = {
      kind: "tool_call",
      agentId: agentId("a"),
      payload: {} satisfies JsonObject,
      grantKey: "x",
      grantedAt: 0,
    };
    expect(g.kind).toBe("tool_call");
    expect(g.agentId).toBe(agentId("a"));
  });

  it("ApprovalQuery requires agentId for actor-scope match", () => {
    const q: ApprovalQuery = {
      kind: "tool_call",
      agentId: agentId("a"),
      payload: {} satisfies JsonObject,
    };
    expect(q.kind).toBe("tool_call");
  });

  it("AliasSpec carries kind/field/from/to", () => {
    const a: AliasSpec = { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" };
    expect(a.from).toBe("bash_exec");
  });

  it("ApprovalStore surface is append + match + load", () => {
    const stub: ApprovalStore = {
      append: async () => undefined,
      match: async () => undefined,
      load: async () => [],
    };
    expect(typeof stub.append).toBe("function");
  });
});
