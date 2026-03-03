import { describe, expect, test } from "bun:test";
import { withErrorHandler } from "./error-handler.js";

describe("withErrorHandler", () => {
  test("passes through successful response", async () => {
    const handler = withErrorHandler(() => new Response("ok"));
    const req = new Request("http://localhost/test");
    const response = await handler(req);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("catches Error and returns 500 with generic message (no leak)", async () => {
    const handler = withErrorHandler(() => {
      throw new Error("Something broke");
    });
    const req = new Request("http://localhost/test");
    const response = await handler(req);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Internal server error" },
    });
  });

  test("catches non-Error thrown values", async () => {
    const handler = withErrorHandler(() => {
      throw "raw string error";
    });
    const req = new Request("http://localhost/test");
    const response = await handler(req);

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: Record<string, unknown>;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL");
  });

  test("catches async errors", async () => {
    const handler = withErrorHandler(async () => {
      await Promise.resolve();
      throw new Error("Async error");
    });
    const req = new Request("http://localhost/test");
    const response = await handler(req);

    expect(response.status).toBe(500);
  });
});
