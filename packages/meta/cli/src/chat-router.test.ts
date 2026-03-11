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
  test("routes to primary handler when no dispatched handler found", async () => {
    const primary = mock(async (_req: Request, _id: string) => new Response("primary"));
    const router = createChatRouter({
      primaryHandler: primary,
      getDispatchedHandler: () => undefined,
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
    });

    const res = await router(makeReq(), "agent-1");
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(primary).not.toHaveBeenCalled();
    expect(await res.text()).toBe("dispatched");
  });

  test("falls through to primary for non-matching dispatched id", async () => {
    const primary = mock(async (_req: Request, _id: string) => new Response("primary"));
    const dispatched = mock(async (_req: Request) => new Response("dispatched"));
    const router = createChatRouter({
      primaryHandler: primary,
      getDispatchedHandler: (id) => (id === "agent-1" ? dispatched : undefined),
    });

    const res = await router(makeReq(), "agent-2");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(dispatched).not.toHaveBeenCalled();
    expect(await res.text()).toBe("primary");
  });
});
