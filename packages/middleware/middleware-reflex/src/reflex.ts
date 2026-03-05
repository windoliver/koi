/**
 * Reflex middleware — rule-based short-circuit for known message patterns.
 *
 * Intercepts `wrapModelCall` and returns canned responses for matching rules,
 * skipping the LLM entirely. Priority 50 (intercept phase, outermost layer).
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import { DEFAULT_COOLDOWN_MS, DEFAULT_PRIORITY, type ReflexMiddlewareConfig } from "./config.js";
import { textOf } from "./text-of.js";
import type { ReflexMetrics, ReflexRule } from "./types.js";

function sortByPriority(rules: readonly ReflexRule[]): readonly ReflexRule[] {
  return [...rules].sort(
    (a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY),
  );
}

function fireMetrics(
  onMetrics: ((m: ReflexMetrics) => void) | undefined,
  metrics: ReflexMetrics,
): void {
  if (onMetrics === undefined) return;
  try {
    onMetrics(metrics);
  } catch (_e: unknown) {
    // Observability callback failure is non-fatal
  }
}

function isCooledDown(
  lastFiredAt: ReadonlyMap<string, number>,
  rule: ReflexRule,
  currentTime: number,
): boolean {
  const cooldownMs = rule.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (cooldownMs <= 0) return false;
  const lastFired = lastFiredAt.get(rule.name);
  return lastFired !== undefined && currentTime - lastFired < cooldownMs;
}

function tryMatch(rule: ReflexRule, message: InboundMessage): boolean {
  try {
    return rule.match(message);
  } catch (_e: unknown) {
    return false;
  }
}

function tryRespond(
  rule: ReflexRule,
  message: InboundMessage,
  ctx: TurnContext,
): string | undefined {
  try {
    return rule.respond(message, ctx);
  } catch (_e: unknown) {
    return undefined;
  }
}

export function createReflexMiddleware(config: ReflexMiddlewareConfig): KoiMiddleware {
  const enabled = config.enabled ?? true;
  const now = config.now ?? Date.now;
  const onMetrics = config.onMetrics;
  const sortedRules = sortByPriority(config.rules);

  // Mutable cooldown state — per-instance, not shared
  const lastFiredAt = new Map<string, number>();

  return {
    name: "koi:reflex",
    priority: 50,
    phase: "intercept",

    describeCapabilities: () => undefined,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (!enabled || ctx.messages.length === 0) {
        return next(request);
      }

      const lastMessage = ctx.messages[ctx.messages.length - 1];
      if (lastMessage === undefined) {
        return next(request);
      }
      const startTime = now();

      for (const rule of sortedRules) {
        if (isCooledDown(lastFiredAt, rule, now())) continue;
        if (!tryMatch(rule, lastMessage)) continue;

        const responseContent = tryRespond(rule, lastMessage, ctx);
        if (responseContent === undefined) continue;

        const matchTime = now();
        lastFiredAt.set(rule.name, matchTime);

        fireMetrics(onMetrics, {
          ruleName: rule.name,
          kind: "hit",
          interceptedContentLength: textOf(lastMessage).length,
          responseLength: responseContent.length,
          latencyMs: matchTime - startTime,
        });

        return {
          content: responseContent,
          model: "koi:reflex",
          usage: { inputTokens: 0, outputTokens: 0 },
          metadata: { reflexRule: rule.name, reflexHit: true },
        };
      }

      fireMetrics(onMetrics, {
        ruleName: "",
        kind: "miss",
        latencyMs: now() - startTime,
      });

      return next(request);
    },
  };
}
