import { describe, expect, mock, test } from "bun:test";
import type { ToolRequest, ToolResponse } from "@koi/core";
import { createPolicyCacheMiddleware, type PolicyEntry } from "./policy-cache.js";

function makeToolReq(toolId: string, input: Record<string, unknown> = {}): ToolRequest {
  return { toolId, input };
}

function makeToolResp(): ToolResponse {
  return { output: "ok" };
}

function makePolicy(
  toolId: string,
  brickId: string,
  decision: "allow" | "block" = "allow",
): PolicyEntry {
  return {
    toolId,
    brickId,
    execute: () =>
      decision === "allow"
        ? { action: "allow" as const }
        : { action: "block" as const, reason: "Blocked by policy" },
  };
}

describe("createPolicyCacheMiddleware", () => {
  test("has correct name, priority, and phase", () => {
    const handle = createPolicyCacheMiddleware();
    expect(handle.middleware.name).toBe("policy-cache");
    expect(handle.middleware.priority).toBe(150);
    expect(handle.middleware.phase).toBe("intercept");
  });

  test("passes through when no policy cached for tool", async () => {
    const handle = createPolicyCacheMiddleware();
    const req = makeToolReq("search", { query: "test" });
    const next = mock(async () => makeToolResp());
    const wrapToolCall = handle.middleware.wrapToolCall;
    expect(wrapToolCall).toBeDefined();
    if (wrapToolCall === undefined) return;

    const result = await wrapToolCall({} as never, req, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("ok");
  });

  test("passes through when policy allows the call", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "allow"));

    const req = makeToolReq("search", { query: "test" });
    const next = mock(async () => makeToolResp());
    const wrapToolCall = handle.middleware.wrapToolCall;
    expect(wrapToolCall).toBeDefined();
    if (wrapToolCall === undefined) return;

    const result = await wrapToolCall({} as never, req, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("ok");
  });

  test("blocks when policy rejects the call", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "block"));

    const req = makeToolReq("search", { query: "" });
    const next = mock(async () => makeToolResp());
    const wrapToolCall = handle.middleware.wrapToolCall;
    expect(wrapToolCall).toBeDefined();
    if (wrapToolCall === undefined) return;

    const result = await wrapToolCall({} as never, req, next);

    // Should NOT call next — model/tool call is short-circuited
    expect(next).toHaveBeenCalledTimes(0);
    const output = result.output as { readonly error: boolean; readonly message: string };
    expect(output.error).toBe(true);
    expect(output.message).toContain("Policy blocked");
  });

  test("evicts policy by brick ID", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1"));
    expect(handle.size()).toBe(1);

    handle.evict("brick-1");
    expect(handle.size()).toBe(0);
  });

  test("evict is no-op for unknown brick ID", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1"));
    handle.evict("unknown-brick");
    expect(handle.size()).toBe(1);
  });

  test("replaces existing policy for same tool", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "allow"));
    handle.register(makePolicy("search", "brick-2", "block"));
    expect(handle.size()).toBe(1);
  });

  test("cleans stale reverse index when replacing policy for same tool", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "allow"));
    handle.register(makePolicy("search", "brick-2", "block"));
    // Evicting old brick-1 should NOT remove the current search policy
    handle.evict("brick-1");
    expect(handle.size()).toBe(1); // brick-2 still active
  });

  test("respects maxEntries limit", () => {
    const handle = createPolicyCacheMiddleware({ maxEntries: 2 });
    handle.register(makePolicy("tool-a", "brick-a"));
    handle.register(makePolicy("tool-b", "brick-b"));
    handle.register(makePolicy("tool-c", "brick-c"));
    // Should evict oldest (tool-a) to stay within limit
    expect(handle.size()).toBe(2);
  });

  test("only intercepts registered tools", async () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1", "block"));

    const req = makeToolReq("write_file", { path: "/tmp/test" });
    const next = mock(async () => makeToolResp());
    const wrapToolCall = handle.middleware.wrapToolCall;
    if (wrapToolCall === undefined) return;

    await wrapToolCall({} as never, req, next);

    // write_file is not cached — should pass through
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("describeCapabilities returns undefined when empty", () => {
    const handle = createPolicyCacheMiddleware();
    const desc = handle.middleware.describeCapabilities({} as never);
    expect(desc).toBeUndefined();
  });

  test("describeCapabilities returns summary when policies registered", () => {
    const handle = createPolicyCacheMiddleware();
    handle.register(makePolicy("search", "brick-1"));
    const desc = handle.middleware.describeCapabilities({} as never);
    expect(desc).not.toBeUndefined();
    expect(desc?.label).toBe("policy-cache");
    expect(desc?.description).toContain("1 tool");
  });

  test("event-driven invalidation via notifier", async () => {
    let subscribedCallback:
      | ((event: { readonly kind: string; readonly brickId: string }) => void)
      | undefined;
    const mockNotifier = {
      notify: mock(async () => {}),
      subscribe: mock(
        (cb: (event: { readonly kind: string; readonly brickId: string }) => void) => {
          subscribedCallback = cb;
        },
      ),
    };

    const handle = createPolicyCacheMiddleware({ notifier: mockNotifier as never });
    handle.register(makePolicy("search", "brick-1"));
    expect(handle.size()).toBe(1);

    // Simulate deprecation event
    await new Promise((resolve) => setTimeout(resolve, 10));
    subscribedCallback?.({ kind: "updated", brickId: "brick-1" });
    expect(handle.size()).toBe(0);
  });
});
