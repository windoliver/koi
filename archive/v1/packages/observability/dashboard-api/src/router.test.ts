import { describe, expect, test } from "bun:test";
import { createRouter, errorResponse, jsonResponse, mapResultToResponse } from "./router.js";

describe("createRouter", () => {
  test("matches exact path", () => {
    const router = createRouter([
      { method: "GET", pattern: "/health", handler: () => new Response("ok") },
    ]);
    const match = router.match("GET", "/health");
    expect(match).toBeDefined();
    expect(match?.params).toEqual({});
  });

  test("matches path with params", () => {
    const router = createRouter([
      { method: "GET", pattern: "/agents/:id", handler: () => new Response("ok") },
    ]);
    const match = router.match("GET", "/agents/agent-123");
    expect(match).toBeDefined();
    expect(match?.params).toEqual({ id: "agent-123" });
  });

  test("matches path with multiple params", () => {
    const router = createRouter([
      {
        method: "GET",
        pattern: "/agents/:agentId/sessions/:sessionId",
        handler: () => new Response("ok"),
      },
    ]);
    const match = router.match("GET", "/agents/a1/sessions/s2");
    expect(match?.params).toEqual({ agentId: "a1", sessionId: "s2" });
  });

  test("returns undefined for non-matching path", () => {
    const router = createRouter([
      { method: "GET", pattern: "/health", handler: () => new Response("ok") },
    ]);
    expect(router.match("GET", "/unknown")).toBeUndefined();
  });

  test("returns undefined for non-matching method", () => {
    const router = createRouter([
      { method: "GET", pattern: "/health", handler: () => new Response("ok") },
    ]);
    expect(router.match("POST", "/health")).toBeUndefined();
  });

  test("first matching route wins", () => {
    const router = createRouter([
      { method: "GET", pattern: "/agents", handler: () => new Response("list") },
      { method: "GET", pattern: "/agents", handler: () => new Response("second") },
    ]);
    const match = router.match("GET", "/agents");
    expect(match).toBeDefined();
  });
});

describe("jsonResponse", () => {
  test("returns 200 with JSON envelope", async () => {
    const response = jsonResponse({ name: "test" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, data: { name: "test" } });
  });

  test("supports custom status code", async () => {
    const response = jsonResponse("created", 201);
    expect(response.status).toBe(201);
  });

  test("sets content-type header", () => {
    const response = jsonResponse(null);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});

describe("errorResponse", () => {
  test("returns error envelope", async () => {
    const response = errorResponse("NOT_FOUND", "Agent not found", 404);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Agent not found" },
    });
  });
});

describe("mapResultToResponse", () => {
  test("returns undefined for ok result", () => {
    expect(mapResultToResponse({ ok: true })).toBeUndefined();
  });

  test("maps NOT_FOUND to 404", () => {
    const res = mapResultToResponse({ ok: false, error: { code: "NOT_FOUND", message: "gone" } });
    if (res === undefined) throw new Error("expected a response");
    expect(res.status).toBe(404);
  });

  test("maps PERMISSION to 403", () => {
    const res = mapResultToResponse({
      ok: false,
      error: { code: "PERMISSION", message: "denied" },
    });
    if (res === undefined) throw new Error("expected a response");
    expect(res.status).toBe(403);
  });

  test("maps CONFLICT to 409", () => {
    const res = mapResultToResponse({
      ok: false,
      error: { code: "CONFLICT", message: "already terminated" },
    });
    if (res === undefined) throw new Error("expected a response");
    expect(res.status).toBe(409);
  });

  test("maps unknown codes to 500", () => {
    const res = mapResultToResponse({ ok: false, error: { code: "INTERNAL", message: "oops" } });
    if (res === undefined) throw new Error("expected a response");
    expect(res.status).toBe(500);
  });
});
