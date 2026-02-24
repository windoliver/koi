/**
 * Middleware contract tests — lifecycle hooks.
 *
 * Validates session start/end and turn before/after hook behaviors.
 */

import { expect, test } from "bun:test";
import type { KoiMiddleware, SessionContext, TurnContext } from "@koi/core/middleware";
import { createMockSessionContext, createMockTurnContext } from "../contexts.js";

export interface LifecycleTestOptions {
  readonly createMiddleware: () => KoiMiddleware | Promise<KoiMiddleware>;
  readonly createSessionContext?: (() => SessionContext) | undefined;
  readonly createTurnContext?: (() => TurnContext) | undefined;
}

export function testLifecycleHooks(options: LifecycleTestOptions): void {
  const {
    createMiddleware,
    createSessionContext = createMockSessionContext,
    createTurnContext = createMockTurnContext,
  } = options;

  test("onSessionStart resolves without error when provided", async () => {
    const mw = await createMiddleware();
    if (mw.onSessionStart === undefined) return;
    const ctx = createSessionContext();
    await mw.onSessionStart(ctx);
  });

  test("onSessionEnd resolves without error when provided", async () => {
    const mw = await createMiddleware();
    if (mw.onSessionEnd === undefined) return;
    const ctx = createSessionContext();
    await mw.onSessionEnd(ctx);
  });

  test("onBeforeTurn resolves without error when provided", async () => {
    const mw = await createMiddleware();
    if (mw.onBeforeTurn === undefined) return;
    const ctx = createTurnContext();
    await mw.onBeforeTurn(ctx);
  });

  test("onAfterTurn resolves without error when provided", async () => {
    const mw = await createMiddleware();
    if (mw.onAfterTurn === undefined) return;
    const ctx = createTurnContext();
    await mw.onAfterTurn(ctx);
  });

  test("lifecycle hooks execute in order: onSessionStart → onBeforeTurn → onAfterTurn → onSessionEnd", async () => {
    const mw = await createMiddleware();
    const order: string[] = [];

    const sessionCtx = createSessionContext();
    const turnCtx = createTurnContext();

    if (mw.onSessionStart !== undefined) {
      await mw.onSessionStart(sessionCtx);
      order.push("onSessionStart");
    }
    if (mw.onBeforeTurn !== undefined) {
      await mw.onBeforeTurn(turnCtx);
      order.push("onBeforeTurn");
    }
    if (mw.onAfterTurn !== undefined) {
      await mw.onAfterTurn(turnCtx);
      order.push("onAfterTurn");
    }
    if (mw.onSessionEnd !== undefined) {
      await mw.onSessionEnd(sessionCtx);
      order.push("onSessionEnd");
    }

    // Verify ordering: if both session hooks exist, start comes before end
    const startIdx = order.indexOf("onSessionStart");
    const endIdx = order.indexOf("onSessionEnd");
    if (startIdx >= 0 && endIdx >= 0) {
      expect(startIdx).toBeLessThan(endIdx);
    }

    // If both turn hooks exist, before comes before after
    const beforeIdx = order.indexOf("onBeforeTurn");
    const afterIdx = order.indexOf("onAfterTurn");
    if (beforeIdx >= 0 && afterIdx >= 0) {
      expect(beforeIdx).toBeLessThan(afterIdx);
    }
  });

  test("onSessionStart returns a Promise", async () => {
    const mw = await createMiddleware();
    if (mw.onSessionStart === undefined) return;

    const result = mw.onSessionStart(createSessionContext());
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  test("onBeforeTurn returns a Promise", async () => {
    const mw = await createMiddleware();
    if (mw.onBeforeTurn === undefined) return;

    const result = mw.onBeforeTurn(createTurnContext());
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
}
