import { describe, expect, test } from "bun:test";
import {
  agentId,
  type HandoffEnvelope,
  handoffId,
  type ModelRequest,
  type ModelResponse,
  type TurnContext,
} from "@koi/core";
import { createHandoffMiddleware } from "./middleware.js";
import { createInMemoryHandoffStore } from "./store.js";

function makeEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: handoffId(crypto.randomUUID()),
    from: agentId("agent-a"),
    to: agentId("agent-b"),
    status: "pending",
    createdAt: Date.now(),
    phase: { completed: "x", next: "y" },
    context: { results: {}, artifacts: [], decisions: [], warnings: [] },
    metadata: {},
    ...overrides,
  };
}

const fakeCtx = { metadata: {} } as unknown as TurnContext;

const fakeResponse: ModelResponse = { content: "ok", model: "test" };

describe("createHandoffMiddleware", () => {
  test("describeCapabilities advertises pending handoff", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const mw = createHandoffMiddleware({ store, agentId: agentId("agent-b") });
    const cap = mw.describeCapabilities(fakeCtx);
    expect(cap?.label).toBe("handoff");
    expect(cap?.description).toContain(env.id);
  });

  test("wrapModelCall injects summary on first call only", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const mw = createHandoffMiddleware({ store, agentId: agentId("agent-b") });
    const seen: ModelRequest[] = [];
    const next = async (req: ModelRequest) => {
      seen.push(req);
      return fakeResponse;
    };
    const baseRequest: ModelRequest = { messages: [] };
    if (mw.wrapModelCall === undefined) throw new Error("missing");
    await mw.wrapModelCall(fakeCtx, baseRequest, next);
    await mw.wrapModelCall(fakeCtx, baseRequest, next);

    const first = seen[0];
    const second = seen[1];
    if (first === undefined || second === undefined) throw new Error("expected two calls");
    expect(first.messages.length).toBe(1);
    expect(second.messages.length).toBe(0);

    const after = await store.get(env.id);
    if (after.ok) expect(after.value.status).toBe("injected");
  });

  test("emits handoff:injected event on first injection", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const events: string[] = [];
    const mw = createHandoffMiddleware({
      store,
      agentId: agentId("agent-b"),
      onEvent: (e) => events.push(e.kind),
    });
    if (mw.wrapModelCall === undefined) throw new Error("missing");
    await mw.wrapModelCall(fakeCtx, { messages: [] }, async () => fakeResponse);
    expect(events).toContain("handoff:injected");
  });

  test("onBeforeTurn populates ctx.metadata with handoff fields", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const mw = createHandoffMiddleware({ store, agentId: agentId("agent-b") });
    const ctx = { metadata: {} as Record<string, unknown> } as unknown as TurnContext;
    if (mw.onBeforeTurn === undefined) throw new Error("missing");
    await mw.onBeforeTurn(ctx);
    const meta = ctx.metadata as Record<string, unknown>;
    expect(meta.handoffId).toBe(env.id);
    expect(meta.handoffPhase).toBe(env.phase.next);
  });
});
