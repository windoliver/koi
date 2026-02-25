import { describe, expect, test } from "bun:test";
import type { KoiMiddleware } from "@koi/core";
import { createMockSessionContext } from "@koi/test-utils";
import { runMiddlewareChecks } from "./middleware-checks.js";

const TIMEOUT = 5_000;

function createSessionCtx() {
  return createMockSessionContext();
}

describe("runMiddlewareChecks", () => {
  test("returns skip when no middleware provided", async () => {
    const results = await runMiddlewareChecks([], createSessionCtx, TIMEOUT);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skip");
  });

  test("passes for middleware with valid name and no hooks", async () => {
    const mw: KoiMiddleware = { name: "noop" };
    const results = await runMiddlewareChecks([mw], createSessionCtx, TIMEOUT);
    const nameCheck = results.find((r) => r.name.includes("has valid name"));
    const hookCheck = results.find((r) => r.name.includes("hooks are functions"));
    expect(nameCheck?.status).toBe("pass");
    expect(hookCheck?.status).toBe("pass");
  });

  test("fails for middleware with empty name", async () => {
    const mw: KoiMiddleware = { name: "" };
    const results = await runMiddlewareChecks([mw], createSessionCtx, TIMEOUT);
    const nameCheck = results.find((r) => r.name.includes("has valid name"));
    expect(nameCheck?.status).toBe("fail");
  });

  test("passes when onSessionStart executes without error", async () => {
    const mw: KoiMiddleware = {
      name: "good-lifecycle",
      async onSessionStart() {},
    };
    const results = await runMiddlewareChecks([mw], createSessionCtx, TIMEOUT);
    const startCheck = results.find((r) => r.name.includes("onSessionStart"));
    expect(startCheck?.status).toBe("pass");
  });

  test("fails when onSessionStart throws", async () => {
    const mw: KoiMiddleware = {
      name: "bad-lifecycle",
      async onSessionStart() {
        throw new Error("session start failed");
      },
    };
    const results = await runMiddlewareChecks([mw], createSessionCtx, TIMEOUT);
    const startCheck = results.find((r) => r.name.includes("onSessionStart"));
    expect(startCheck?.status).toBe("fail");
    expect(startCheck?.error?.message).toContain("session start failed");
  });

  test("passes when onSessionEnd executes without error", async () => {
    const mw: KoiMiddleware = {
      name: "good-end",
      async onSessionEnd() {},
    };
    const results = await runMiddlewareChecks([mw], createSessionCtx, TIMEOUT);
    const endCheck = results.find((r) => r.name.includes("onSessionEnd"));
    expect(endCheck?.status).toBe("pass");
  });

  test("fails when onSessionEnd throws", async () => {
    const mw: KoiMiddleware = {
      name: "bad-end",
      async onSessionEnd() {
        throw new Error("session end failed");
      },
    };
    const results = await runMiddlewareChecks([mw], createSessionCtx, TIMEOUT);
    const endCheck = results.find((r) => r.name.includes("onSessionEnd"));
    expect(endCheck?.status).toBe("fail");
  });

  test("handles multiple middleware sequentially", async () => {
    const mw1: KoiMiddleware = { name: "mw-a", async onSessionStart() {} };
    const mw2: KoiMiddleware = { name: "mw-b" };
    const results = await runMiddlewareChecks([mw1, mw2], createSessionCtx, TIMEOUT);
    // mw-a: name + hooks + onSessionStart = 3 checks
    // mw-b: name + hooks = 2 checks
    expect(results).toHaveLength(5);
  });

  test("does not test onSessionStart/End when not provided", async () => {
    const mw: KoiMiddleware = { name: "minimal" };
    const results = await runMiddlewareChecks([mw], createSessionCtx, TIMEOUT);
    // Only structural checks: name + hooks
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
});
