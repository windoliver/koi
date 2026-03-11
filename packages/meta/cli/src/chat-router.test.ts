/**
 * Tests for createChatRouter — routes AG-UI chat requests by agentId.
 */

import { describe, expect, mock, test } from "bun:test";
import { createChatRouter } from "./chat-router.js";

function makeReq(): Request {
  return new Request("http://localhost/agents/test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "t1", messages: [] }),
  });
}

describe("createChatRouter", () => {
  test("routes to primary handler when agentId is primary", async () => {
    const primary = mock(async (_req: Request, _id: string) => new Response("primary"));
    const router = createChatRouter({
      primaryHandler: primary,
      getDispatchedHandler: () => undefined,
      isPrimaryAgent: (id) => id === "primary-agent",
    });

    const res = await router(makeReq(), "primary-agent");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("primary");
  });

  test("routes to dispatched handler when found", async () => {
    const primary = mock(async (_req: Request, _id: string) => new Response("primary"));
    const dispatched = mock(async (_req: Request) => new Response("dispatched"));
    const router = createChatRouter({
      primaryHandler: primary,
      getDispatchedHandler: (id) => (id === "agent-1" ? dispatched : undefined),
      isPrimaryAgent: (id) => id === "primary-agent",
    });

    const res = await router(makeReq(), "agent-1");
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(primary).not.toHaveBeenCalled();
    expect(await res.text()).toBe("dispatched");
  });

  test("returns 404 for unknown agent that is not primary", async () => {
    const primary = mock(async (_req: Request, _id: string) => new Response("primary"));
    const router = createChatRouter({
      primaryHandler: primary,
      getDispatchedHandler: () => undefined,
      isPrimaryAgent: (id) => id === "primary-agent",
    });

    const res = await router(makeReq(), "unknown-agent");
    expect(primary).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("dispatched handler takes priority over primary check", async () => {
    const primary = mock(async (_req: Request, _id: string) => new Response("primary"));
    const dispatched = mock(async (_req: Request) => new Response("dispatched"));
    const router = createChatRouter({
      primaryHandler: primary,
      getDispatchedHandler: (id) => (id === "primary-agent" ? dispatched : undefined),
      isPrimaryAgent: (id) => id === "primary-agent",
    });

    // Even though this ID is the primary, dispatched handler takes priority
    const res = await router(makeReq(), "primary-agent");
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(primary).not.toHaveBeenCalled();
    expect(await res.text()).toBe("dispatched");
  });
});
