import { describe, expect, mock, test } from "bun:test";
import type { KoiError, ModelRequest, ModelResponse, Result } from "@koi/core";
import { createModelRouterMiddleware } from "./middleware.js";
import type { ModelRouter } from "./router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(text = "Hello"): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text" as const, text }], senderId: "test-user", timestamp: 0 }],
  };
}

function makeResponse(content: string, model = "gpt-4o"): ModelResponse {
  return { content, model };
}

function makeRouter(routeFn: ModelRouter["route"]): ModelRouter {
  return {
    route: routeFn,
    async *routeStream() {
      yield { kind: "finish" as const, reason: "completed" };
    },
    getHealth: () => new Map(),
    getMetrics: () => ({
      totalRequests: 0,
      totalFailures: 0,
      requestsByTarget: {},
      failuresByTarget: {},
    }),
    dispose: () => {},
  };
}

// ---------------------------------------------------------------------------
// createModelRouterMiddleware
// ---------------------------------------------------------------------------

describe("createModelRouterMiddleware", () => {
  test("has correct name and priority", () => {
    const router = makeRouter(() => Promise.resolve({ ok: true, value: makeResponse("ok") }));
    const mw = createModelRouterMiddleware(router);

    expect(mw.name).toBe("model-router");
    expect(mw.priority).toBe(900);
  });

  test("wrapModelCall delegates to router.route on success", async () => {
    const response = makeResponse("Hello from router!", "gpt-4o");
    const routeFn = mock(() =>
      Promise.resolve({ ok: true, value: response } as Result<ModelResponse, KoiError>),
    );
    const router = makeRouter(routeFn);
    const mw = createModelRouterMiddleware(router);

    const request = makeRequest("Hi");
    const next = mock(() => Promise.resolve(makeResponse("should not be called")));

    if (!mw.wrapModelCall) throw new Error("Expected wrapModelCall");
    const result = await mw.wrapModelCall(
      {} as Parameters<typeof mw.wrapModelCall>[0],
      request,
      next,
    );

    expect(result.content).toBe("Hello from router!");
    expect(routeFn).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled(); // middleware intercepts, does not call next
  });

  test("wrapModelCall throws when router returns error", async () => {
    const error: KoiError = {
      code: "EXTERNAL",
      message: "All targets failed",
      retryable: false,
    };
    const routeFn = mock(() =>
      Promise.resolve({ ok: false, error } as Result<ModelResponse, KoiError>),
    );
    const router = makeRouter(routeFn);
    const mw = createModelRouterMiddleware(router);

    const request = makeRequest("Hi");
    const next = mock(() => Promise.resolve(makeResponse("unused")));

    if (!mw.wrapModelCall) throw new Error("Expected wrapModelCall");
    try {
      await mw.wrapModelCall({} as Parameters<typeof mw.wrapModelCall>[0], request, next);
      throw new Error("Should have thrown");
    } catch (e: unknown) {
      const thrown = e as KoiError;
      expect(thrown.code).toBe("EXTERNAL");
      expect(thrown.message).toBe("All targets failed");
    }

    expect(routeFn).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  test("passes the original request to the router", async () => {
    const routeFn = mock((req: ModelRequest) => {
      const firstBlock = req.messages[0]?.content[0];
      expect(firstBlock?.kind === "text" ? firstBlock.text : "").toBe("Specific message");
      return Promise.resolve({
        ok: true,
        value: makeResponse("ok"),
      } as Result<ModelResponse, KoiError>);
    });
    const router = makeRouter(routeFn);
    const mw = createModelRouterMiddleware(router);

    if (!mw.wrapModelCall) throw new Error("Expected wrapModelCall");
    await mw.wrapModelCall(
      {} as Parameters<typeof mw.wrapModelCall>[0],
      makeRequest("Specific message"),
      () => Promise.resolve(makeResponse("unused")),
    );

    expect(routeFn).toHaveBeenCalledTimes(1);
  });
});
