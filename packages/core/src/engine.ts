/**
 * Engine adapter contract — swappable agent loop.
 */

import type { ContentBlock, InboundMessage } from "./message.js";

export type EngineStopReason = "completed" | "max_turns" | "interrupted" | "error";

export interface EngineMetrics {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
  readonly durationMs: number;
}

export interface EngineOutput {
  readonly content: readonly ContentBlock[];
  readonly stopReason: EngineStopReason;
  readonly metrics: EngineMetrics;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EngineState {
  readonly engineId: string;
  readonly data: unknown;
}

export type EngineInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "messages"; readonly messages: readonly InboundMessage[] }
  | { readonly kind: "resume"; readonly state: EngineState };

export type EngineEvent =
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "tool_call_start"; readonly toolId: string; readonly input: unknown }
  | { readonly kind: "tool_call_end"; readonly toolId: string; readonly output: unknown }
  | { readonly kind: "turn_end"; readonly turnIndex: number }
  | { readonly kind: "done"; readonly output: EngineOutput }
  | { readonly kind: "custom"; readonly type: string; readonly data: unknown };

export interface EngineAdapter {
  readonly engineId: string;
  readonly stream: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly saveState?: () => Promise<EngineState>;
  readonly loadState?: (state: EngineState) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}
