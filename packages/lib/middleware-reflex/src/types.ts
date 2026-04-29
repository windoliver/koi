import type { InboundMessage, TurnContext } from "@koi/core";

export interface ReflexRule {
  readonly name: string;
  readonly match: (message: InboundMessage) => boolean;
  readonly respond: (message: InboundMessage, ctx: TurnContext) => string;
  /** Lower = checked first. Default: 100. */
  readonly priority?: number;
  /** Per-rule cooldown in milliseconds. 0 = no cooldown. Default: 0. */
  readonly cooldownMs?: number;
}

export interface ReflexMiddlewareConfig {
  readonly rules: readonly ReflexRule[];
  /** Master switch. Default: true. */
  readonly enabled?: boolean;
  /** Clock injection for deterministic tests. Default: Date.now. */
  readonly now?: () => number;
}
