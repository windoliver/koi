import { describe, expect, it, spyOn } from "bun:test";
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
      agentId: grant.agentId,
      payload: grant.payload,
      grantKey: grant.grantKey,
      grantedAt: grant.grantedAt,
    });
  });

  it("preserves agentId on the persisted record (actor scope guard)", async () => {
    const { store, appended } = makeStore();
    const sink = createPersistSink(store);
    await sink(grant);
    expect(appended[0]?.agentId).toBe(grant.agentId);
    // sessionId is intentionally dropped — sessions are not durable.
    expect(appended[0]).not.toHaveProperty("sessionId");
  });

  it("uses resolveAgentId when provided so hosts can pin a stable scope", async () => {
    const { store, appended } = makeStore();
    const stable = agentId("koi-tui");
    const sink = createPersistSink(store, { resolveAgentId: () => stable });
    await sink(grant);
    expect(appended[0]?.agentId).toBe(stable);
  });

  // Codex round-1 finding: onApprovalPersist is fire-and-forget. Sink
  // failures must not surface as unhandled rejections.
  it("absorbs append errors and never returns a rejected promise", async () => {
    const failingStore: ApprovalStore = {
      append: async () => {
        throw new Error("ENOSPC");
      },
      match: async () => undefined,
      load: async () => [],
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = createPersistSink(failingStore);
    // Must NOT throw / reject.
    await sink(grant);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
