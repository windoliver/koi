/**
 * Middleware structural and lifecycle checks.
 *
 * Verifies that each middleware has a valid name, hooks are functions,
 * and lifecycle hooks (onSessionStart, onSessionEnd) execute without error.
 */

import type { KoiMiddleware, SessionContext } from "@koi/core";
import { runCheck, skipCheck } from "../check-runner.js";
import type { CheckResult } from "../types.js";

const HOOK_NAMES = [
  "onSessionStart",
  "onSessionEnd",
  "onBeforeTurn",
  "onAfterTurn",
  "wrapModelCall",
  "wrapModelStream",
  "wrapToolCall",
] as const;

export async function runMiddlewareChecks(
  middleware: readonly KoiMiddleware[],
  createSessionCtx: () => SessionContext,
  checkTimeoutMs: number,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];

  if (middleware.length === 0) {
    results.push(
      skipCheck("middleware: no middleware to check", "middleware", "No middleware provided"),
    );
    return results;
  }

  for (const mw of middleware) {
    // Structural: name is valid
    results.push(
      await runCheck(
        `middleware[${mw.name}]: has valid name`,
        "middleware",
        () => {
          if (typeof mw.name !== "string" || mw.name.trim().length === 0) {
            throw new Error("Middleware name must be a non-empty string");
          }
        },
        checkTimeoutMs,
      ),
    );

    // Structural: all hooks are functions (or undefined)
    results.push(
      await runCheck(
        `middleware[${mw.name}]: hooks are functions`,
        "middleware",
        () => {
          for (const hookName of HOOK_NAMES) {
            const hook = mw[hookName];
            if (hook !== undefined && typeof hook !== "function") {
              throw new Error(`middleware.${hookName} must be a function, got ${typeof hook}`);
            }
          }
        },
        checkTimeoutMs,
      ),
    );

    // Lifecycle: onSessionStart executes without error
    const sessionStart = mw.onSessionStart;
    if (sessionStart !== undefined) {
      results.push(
        await runCheck(
          `middleware[${mw.name}]: onSessionStart executes`,
          "middleware",
          async () => {
            const ctx = createSessionCtx();
            await sessionStart(ctx);
          },
          checkTimeoutMs,
        ),
      );
    }

    // Lifecycle: onSessionEnd executes without error
    const sessionEnd = mw.onSessionEnd;
    if (sessionEnd !== undefined) {
      results.push(
        await runCheck(
          `middleware[${mw.name}]: onSessionEnd executes`,
          "middleware",
          async () => {
            const ctx = createSessionCtx();
            await sessionEnd(ctx);
          },
          checkTimeoutMs,
        ),
      );
    }
  }

  return results;
}
