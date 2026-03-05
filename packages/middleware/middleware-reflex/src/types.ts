/**
 * Reflex middleware types — rule-based short-circuit for known patterns.
 */

import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";

/**
 * A single reflex rule that can intercept an inbound message
 * and return a canned response without hitting the LLM.
 */
export interface ReflexRule {
  readonly name: string;
  readonly match: (message: InboundMessage) => boolean;
  readonly respond: (message: InboundMessage, ctx: TurnContext) => string;
  /** Lower = checked first. Default: 100. */
  readonly priority?: number;
  /** Per-rule cooldown in milliseconds. Default: 0 (no cooldown). */
  readonly cooldownMs?: number;
}

/** Metrics emitted for each rule evaluation cycle. */
export interface ReflexMetrics {
  readonly ruleName: string;
  readonly kind: "hit" | "miss";
  /** Characters of intercepted request content (hit only). */
  readonly interceptedContentLength?: number;
  /** Characters of reflex response (hit only). */
  readonly responseLength?: number;
  /** Time spent in rule evaluation (ms). */
  readonly latencyMs: number;
}
