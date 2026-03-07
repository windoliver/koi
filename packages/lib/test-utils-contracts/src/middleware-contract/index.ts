/**
 * Middleware contract test suite.
 *
 * Validates that any KoiMiddleware implementation satisfies the L0 contract.
 * Usage: import { testMiddlewareContract } from "@koi/test-utils" and call it
 * inside a describe() block with a factory function.
 */

import { describe, expect, test } from "bun:test";
import type { KoiMiddleware, SessionContext, TurnContext } from "@koi/core/middleware";
import { testLifecycleHooks } from "./lifecycle.js";
import { testOnionHooks } from "./onion.js";

export interface MiddlewareContractOptions {
  /** Factory that creates a fresh middleware instance for each test. */
  readonly createMiddleware: () => KoiMiddleware | Promise<KoiMiddleware>;
  /** Optional custom session context factory. */
  readonly createSessionContext?: (() => SessionContext) | undefined;
  /** Optional custom turn context factory. */
  readonly createTurnContext?: (() => TurnContext) | undefined;
}

/**
 * Runs the middleware contract test suite.
 *
 * Call this inside a `describe()` block. It will register tests that verify
 * the middleware satisfies all L0 contract invariants.
 */
export function testMiddlewareContract(options: MiddlewareContractOptions): void {
  const { createMiddleware, createSessionContext, createTurnContext } = options;

  // --- Core properties ---

  test("name is a non-empty string", async () => {
    const mw = await createMiddleware();
    expect(typeof mw.name).toBe("string");
    expect(mw.name.length).toBeGreaterThan(0);
  });

  test("priority is undefined or a number", async () => {
    const mw = await createMiddleware();
    if (mw.priority !== undefined) {
      expect(typeof mw.priority).toBe("number");
    }
  });

  test("all hooks are optional — middleware with zero hooks is valid", async () => {
    const mw = await createMiddleware();
    // At minimum, name must exist. All hooks are optional.
    expect(mw.name).toBeDefined();
    // These checks just verify the property types when present
    if (mw.onSessionStart !== undefined) expect(typeof mw.onSessionStart).toBe("function");
    if (mw.onSessionEnd !== undefined) expect(typeof mw.onSessionEnd).toBe("function");
    if (mw.onBeforeTurn !== undefined) expect(typeof mw.onBeforeTurn).toBe("function");
    if (mw.onAfterTurn !== undefined) expect(typeof mw.onAfterTurn).toBe("function");
    if (mw.wrapModelCall !== undefined) expect(typeof mw.wrapModelCall).toBe("function");
    if (mw.wrapModelStream !== undefined) expect(typeof mw.wrapModelStream).toBe("function");
    if (mw.wrapToolCall !== undefined) expect(typeof mw.wrapToolCall).toBe("function");
  });

  // --- Lifecycle hooks ---
  describe("lifecycle hooks", () => {
    testLifecycleHooks({ createMiddleware, createSessionContext, createTurnContext });
  });

  // --- Onion composition hooks ---
  describe("onion composition hooks", () => {
    testOnionHooks({ createMiddleware, createTurnContext });
  });
}
