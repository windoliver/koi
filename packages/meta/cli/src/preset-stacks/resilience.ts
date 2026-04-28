/**
 * Resilience preset stack — bounds runaway agent loops and degrades
 * gracefully under provider failure.
 *
 * Contributes three intercept-phase middleware:
 *   - `koi:circuit-breaker` — trips after repeated provider failures,
 *     fails fast during cooldown, allows a single probe to detect
 *     recovery. Keyed per-provider (model prefix before "/").
 *   - `koi:model-call-limit` — hard ceiling on total model calls per
 *     session. Failed/abandoned attempts refund quota.
 *   - `koi:tool-call-limit` — global per-session tool call ceiling.
 *
 * `koi:call-dedup` is intentionally NOT auto-enabled here. Dedup is
 * opt-in by design (it caches tool responses across calls, which only
 * makes sense for a curated allowlist of deterministic tools). Wiring
 * it without an `include` list would be a passthrough no-op anyway.
 *
 * Defaults are tuned for TUI / interactive use. Runaway-agent
 * scenarios (loops, retries) hit the caps; humans typing prompts
 * never approach them.
 */

import {
  createModelCallLimitMiddleware,
  createToolCallLimitMiddleware,
} from "@koi/middleware-call-limits";
import { createCircuitBreakerMiddleware } from "@koi/middleware-circuit-breaker";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

const DEFAULT_MODEL_CALL_LIMIT = 200;
const DEFAULT_TOOL_GLOBAL_LIMIT = 500;
const DEFAULT_CB_FAILURE_THRESHOLD = 5;
const DEFAULT_CB_COOLDOWN_MS = 30_000;
const DEFAULT_CB_FAILURE_WINDOW_MS = 60_000;

export const resilienceStack: PresetStack = {
  id: "resilience",
  description:
    "Bounded model/tool call limits + per-provider circuit breaker " +
    "(model cap 200/session, tool cap 500/session, breaker trips at 5 failures)",
  activate: (): StackContribution => {
    const breaker = createCircuitBreakerMiddleware({
      breaker: {
        failureThreshold: DEFAULT_CB_FAILURE_THRESHOLD,
        cooldownMs: DEFAULT_CB_COOLDOWN_MS,
        failureWindowMs: DEFAULT_CB_FAILURE_WINDOW_MS,
      },
    });
    const modelLimit = createModelCallLimitMiddleware({ limit: DEFAULT_MODEL_CALL_LIMIT });
    const toolLimit = createToolCallLimitMiddleware({
      globalLimit: DEFAULT_TOOL_GLOBAL_LIMIT,
      exitBehavior: "error",
    });
    return {
      middleware: [breaker, modelLimit, toolLimit],
      providers: [],
    };
  },
};
