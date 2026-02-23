/**
 * Engine adapter contract — swappable agent loop.
 */

import type { JsonObject } from "./common.js";
import type { ToolDescriptor } from "./ecs.js";
import type { ContentBlock, InboundMessage } from "./message.js";
import type {
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "./middleware.js";

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

export interface ComposedCallHandlers {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly modelStream?: (request: ModelRequest) => AsyncIterable<ModelChunk>;
  readonly toolCall: (request: ToolRequest) => Promise<ToolResponse>;
  readonly tools: readonly ToolDescriptor[];
}

export type EngineInput =
  | { readonly kind: "text"; readonly text: string; readonly callHandlers?: ComposedCallHandlers }
  | {
      readonly kind: "messages";
      readonly messages: readonly InboundMessage[];
      readonly callHandlers?: ComposedCallHandlers;
    }
  | {
      readonly kind: "resume";
      readonly state: EngineState;
      readonly callHandlers?: ComposedCallHandlers;
    };

export type EngineEvent =
  | { readonly kind: "text_delta"; readonly delta: string }
  | {
      readonly kind: "tool_call_start";
      readonly toolName: string;
      readonly callId: string;
      readonly args?: JsonObject;
    }
  | { readonly kind: "tool_call_delta"; readonly callId: string; readonly delta: string }
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
  /**
   * Raw function pointers for model/tool calls. When provided, the engine
   * wraps these with the middleware chain and passes the composed handlers
   * back via `EngineInput.callHandlers`. The adapter invokes them at
   * defined points (like a protocol handler calling NF_HOOK()).
   *
   * Non-cooperating adapters (without terminals) work unchanged —
   * they just don't get per-call middleware interposition.
   */
  readonly terminals?: {
    readonly modelCall: ModelHandler;
    readonly modelStream?: ModelStreamHandler;
    readonly toolCall?: ToolHandler;
  };
  /**
   * The sole required method. Returns an async iterable of engine events.
   * Backpressure is handled naturally via `for await` consumption —
   * the consumer controls iteration speed. Implementations should use
   * AsyncGenerator for built-in backpressure support.
   */
  readonly stream: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly saveState?: () => Promise<EngineState>;
  /**
   * Restore adapter state from a previously saved snapshot.
   *
   * @remarks Adapters MUST validate the shape of `state.data` before use.
   * `EngineState.data` is typed as `unknown` to maintain adapter opacity —
   * corrupt or tampered state must produce a typed KoiError (code: "VALIDATION"),
   * never an unhandled runtime crash. Use schema validation (e.g., Zod) or
   * manual type narrowing inside this method.
   */
  readonly loadState?: (state: EngineState) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}
