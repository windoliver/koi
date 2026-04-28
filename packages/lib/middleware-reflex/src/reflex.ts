/**
 * Rule-based short-circuit middleware. Matches inbound messages against
 * registered rules and returns canned responses, skipping the model entirely.
 *
 * Optimization-only: never changes correctness. On any rule failure or miss,
 * falls through to next() unchanged.
 */

import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  TextBlock,
  TurnContext,
} from "@koi/core";

import type { ReflexMiddlewareConfig, ReflexRule } from "./types.js";

const DEFAULT_RULE_PRIORITY = 100;
const MIDDLEWARE_PRIORITY = 50;

/**
 * Extracts concatenated text from an InboundMessage. Non-text blocks
 * (images, files, buttons, custom) are ignored.
 */
export function textOf(message: InboundMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

function sortByPriority(rules: readonly ReflexRule[]): readonly ReflexRule[] {
  return [...rules].sort(
    (a, b) => (a.priority ?? DEFAULT_RULE_PRIORITY) - (b.priority ?? DEFAULT_RULE_PRIORITY),
  );
}

function isCooledDown(
  cooldowns: ReadonlyMap<string, number>,
  rule: ReflexRule,
  currentTime: number,
): boolean {
  const cooldownMs = rule.cooldownMs ?? 0;
  if (cooldownMs <= 0) return false;
  const lastFired = cooldowns.get(rule.name);
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

function buildResponse(ruleName: string, content: string): ModelResponse {
  return {
    content,
    model: "koi:reflex",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "stop",
    metadata: { reflexRule: ruleName, reflexHit: true },
  };
}

function evaluateRules(
  rules: readonly ReflexRule[],
  lastMessage: InboundMessage,
  ctx: TurnContext,
  cooldowns: Map<string, number>,
  now: () => number,
): ModelResponse | undefined {
  for (const rule of rules) {
    const t = now();
    if (isCooledDown(cooldowns, rule, t)) continue;
    if (!tryMatch(rule, lastMessage)) continue;

    const responseContent = tryRespond(rule, lastMessage, ctx);
    if (responseContent === undefined) continue;

    cooldowns.set(rule.name, t);
    return buildResponse(rule.name, responseContent);
  }
  return undefined;
}

export function createReflexMiddleware(config: ReflexMiddlewareConfig): KoiMiddleware {
  const enabled = config.enabled ?? true;
  const now = config.now ?? Date.now;
  const sortedRules = sortByPriority(config.rules);
  // Per-instance cooldown map: rule name → last-fired timestamp (ms)
  const cooldowns = new Map<string, number>();

  return {
    name: "koi:reflex",
    priority: MIDDLEWARE_PRIORITY,
    phase: "intercept",

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment | undefined => undefined,

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      cooldowns.clear();
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (!enabled || ctx.messages.length === 0) return next(request);
      if (request.signal?.aborted === true || ctx.signal?.aborted === true) {
        throw new DOMException("Request aborted", "AbortError");
      }
      const lastMessage = ctx.messages[ctx.messages.length - 1];
      if (lastMessage === undefined) return next(request);

      const hit = evaluateRules(sortedRules, lastMessage, ctx, cooldowns, now);
      return hit ?? next(request);
    },
  };
}
