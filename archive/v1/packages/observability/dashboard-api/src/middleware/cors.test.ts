import { describe, expect, test } from "bun:test";
import { applyCors, handlePreflight } from "./cors.js";

describe("applyCors", () => {
  test("adds CORS headers to response", () => {
    const original = new Response("ok", { status: 200 });
    const corsed = applyCors(original);

    expect(corsed.headers.get("access-control-allow-origin")).toBe("*");
    expect(corsed.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(corsed.headers.get("access-control-allow-headers")).toBe("content-type, last-event-id");
  });

  test("preserves original status and body", async () => {
    const original = new Response("test body", { status: 201 });
    const corsed = applyCors(original);

    expect(corsed.status).toBe(201);
    expect(await corsed.text()).toBe("test body");
  });

  test("preserves existing headers", () => {
    const original = new Response("ok", {
      headers: { "x-custom": "value" },
    });
    const corsed = applyCors(original);

    expect(corsed.headers.get("x-custom")).toBe("value");
    expect(corsed.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("handlePreflight", () => {
  test("returns 204 with CORS headers", () => {
    const response = handlePreflight();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });
});
