import { describe, expect, it } from "bun:test";
import { agentId, type JsonObject, type PersistentGrant, sessionId } from "@koi/core";
import { createPersistSink } from "./persist-sink.js";
import type { ApprovalStore, PersistedApproval } from "./types.js";

function makeStore(): { readonly store: ApprovalStore; readonly appended: PersistedApproval[] } {
  const appended: PersistedApproval[] = [];
  return {
    appended,
    store: {
      append: async (g) => {
        appended.push(g);
      },
      match: async () => undefined,
      load: async () => appended,
    },
  };
}

const grant: PersistentGrant = {
  kind: "tool_call",
  agentId: agentId("a1"),
  sessionId: sessionId("s1"),
  payload: { tool: "bash" } satisfies JsonObject,
  grantKey: "deadbeef",
  grantedAt: 1_713_974_400_000,
};

describe("createPersistSink", () => {
  it("appends a PersistedApproval on each call", async () => {
    const { store, appended } = makeStore();
    const sink = createPersistSink(store);
    await sink(grant);
    expect(appended.length).toBe(1);
    expect(appended[0]).toEqual({
      kind: grant.kind,
      payload: grant.payload,
      grantKey: grant.grantKey,
      grantedAt: grant.grantedAt,
    });
  });

  it("drops agentId and sessionId — they are session-scoped, not content-scoped", async () => {
    const { store, appended } = makeStore();
    const sink = createPersistSink(store);
    await sink(grant);
    expect(appended[0]).not.toHaveProperty("agentId");
    expect(appended[0]).not.toHaveProperty("sessionId");
  });
});
