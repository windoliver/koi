import { describe, expect, test } from "bun:test";
import type {
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createStubMiddleware, PHASE1_MIDDLEWARE_NAMES } from "./stub-middleware.js";

describe("createStubMiddleware", () => {
  test("creates passthrough middleware with correct name and defaults", () => {
    const mw = createStubMiddleware("test-mw");
    expect(mw.name).toBe("test-mw");
    expect(mw.phase).toBe("resolve");
    expect(mw.priority).toBe(500);
  });

  test("wrapModelCall passes request through to next", async () => {
    const mw = createStubMiddleware("test");
    const request = {} as ModelRequest;
    const response = { content: "ok" } as unknown as ModelResponse;
    const next = async (_req: ModelRequest): Promise<ModelResponse> => response;

    const result = await mw.wrapModelCall?.({} as TurnContext, request, next);
    expect(result).toBe(response);
  });

  test("wrapToolCall passes request through to next", async () => {
    const mw = createStubMiddleware("test");
    const request = {} as ToolRequest;
    const response = { output: "ok" } as unknown as ToolResponse;
    const next = async (_req: ToolRequest): Promise<ToolResponse> => response;

    const result = await mw.wrapToolCall?.({} as TurnContext, request, next);
    expect(result).toBe(response);
  });

  test("describeCapabilities returns undefined", () => {
    const mw = createStubMiddleware("test");
    expect(mw.describeCapabilities({} as TurnContext)).toBeUndefined();
  });

  test("accepts custom phase and priority", () => {
    const mw = createStubMiddleware("custom", "intercept", 100);
    expect(mw.phase).toBe("intercept");
    expect(mw.priority).toBe(100);
  });

  test("PHASE1_MIDDLEWARE_NAMES contains expected entries", () => {
    expect(PHASE1_MIDDLEWARE_NAMES).toContain("event-trace");
    expect(PHASE1_MIDDLEWARE_NAMES).toContain("permissions");
    expect(PHASE1_MIDDLEWARE_NAMES).toContain("hooks");
    expect(PHASE1_MIDDLEWARE_NAMES).toContain("context-manager");
    expect(PHASE1_MIDDLEWARE_NAMES).toContain("tool-execution");
  });
});
