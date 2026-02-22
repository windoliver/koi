/**
 * Engine adapter contract — swappable agent loop.
 */

import type { JsonObject } from "./common.js";
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
  readonly metadata?: JsonObject;
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
  | { readonly kind: "tool_call_start"; readonly toolName: string; readonly callId: string }
  | {
      readonly kind: "tool_call_end";
      readonly callId: string;
      readonly result: unknown;
    }
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
