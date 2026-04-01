/**
 * Model adapter contract — provider-agnostic model boundary.
 *
 * Defines the unified interface that all provider adapters implement.
 * Types only — zero logic, zero dependencies beyond L0.
 */

import type { JsonObject } from "./common.js";
import type { ToolCallId } from "./ecs.js";
import type { ModelHandler, ModelStreamHandler } from "./middleware.js";
import type { ModelCapabilities } from "./model-provider.js";

// ---------------------------------------------------------------------------
// Model stop reasons
// ---------------------------------------------------------------------------

/**
 * Why the model stopped generating.
 *
 * - "stop"     — natural end of generation
 * - "length"   — hit max tokens
 * - "tool_use" — model wants to call a tool
 * - "error"    — provider-side error during generation
 */
export type ModelStopReason = "stop" | "length" | "tool_use" | "error";

// ---------------------------------------------------------------------------
// Model content blocks (rich response content)
// ---------------------------------------------------------------------------

export interface ModelTextBlock {
  readonly kind: "text";
  readonly text: string;
}

export interface ModelThinkingBlock {
  readonly kind: "thinking";
  readonly text: string;
  /** Opaque provider signature for multi-turn thinking continuity. */
  readonly signature?: string | undefined;
}

export interface ModelToolCallBlock {
  readonly kind: "tool_call";
  readonly id: ToolCallId;
  readonly name: string;
  readonly arguments: JsonObject;
}

/**
 * Discriminated union of content blocks a model can return.
 * Separate from channel `ContentBlock` — these represent model output,
 * not user/channel messages.
 */
export type ModelContentBlock = ModelTextBlock | ModelThinkingBlock | ModelToolCallBlock;

// ---------------------------------------------------------------------------
// Model adapter interface
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic model adapter.
 *
 * Bundles `complete` (non-streaming) and `stream` (streaming) handlers with
 * provider metadata and capabilities. Engine adapters use `ModelAdapter.complete`
 * and `ModelAdapter.stream` as terminals for the middleware chain.
 *
 * Implementations MUST:
 * - Use `async function*` (or equivalent pull-based iteration) for `stream`
 *   to ensure natural backpressure — no unbounded push queues.
 * - Perform all request preparation (message/tool mapping) before the HTTP call.
 * - Pass `ModelRequest.signal` directly to `fetch()` for immediate abort propagation.
 * - Normalize provider errors into `ModelChunk` error variants with `KoiErrorCode`.
 */
export interface ModelAdapter {
  /** Unique identifier for this adapter instance. */
  readonly id: string;
  /** Provider name (e.g., "openrouter", "openai", "anthropic"). */
  readonly provider: string;
  /** Declared model capabilities for routing decisions. */
  readonly capabilities: ModelCapabilities;
  /** Non-streaming model call. */
  readonly complete: ModelHandler;
  /** Streaming model call. */
  readonly stream: ModelStreamHandler;
  /** Optional cleanup (e.g., close persistent connections). */
  readonly dispose?: (() => Promise<void>) | undefined;
}
