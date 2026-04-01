/**
 * Configuration and extended adapter types for the pi-agent-core engine adapter.
 */

import type { EngineAdapter } from "@koi/core/engine";

/**
 * Thinking/reasoning level for models that support it.
 * Maps directly to pi-agent-core's ThinkingLevel.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Opaque context message for the transform function boundary.
 * Mirrors the shape needed by the underlying engine without exposing vendor types.
 * The adapter converts to/from the vendor's AgentMessage internally.
 */
export interface ContextMessage {
  readonly role: string;
  readonly content: unknown;
  readonly timestamp?: number;
}

/**
 * Transform function for context window management.
 * Applied before each LLM call to prune/inject messages.
 */
export type TransformContextFn = (
  messages: readonly ContextMessage[],
  signal?: AbortSignal,
) => Promise<readonly ContextMessage[]>;

/**
 * Dynamic API key resolver, called before each LLM call.
 * Useful for short-lived OAuth tokens.
 */
export type GetApiKeyFn = (provider: string) => Promise<string | undefined> | string | undefined;

/**
 * Configuration for creating a pi engine adapter.
 */
export interface PiAdapterConfig {
  /** Model identifier as "provider:model-id" (e.g. "anthropic:claude-sonnet-4-5-20250929"). */
  readonly model: string;
  /** System prompt for the agent. */
  readonly systemPrompt?: string;
  /** Context window management function applied before each LLM call. */
  readonly transformContext?: TransformContextFn;
  /** Dynamic API key resolver for each LLM call. */
  readonly getApiKey?: GetApiKeyFn;
  /** Thinking/reasoning level. Defaults to "off". */
  readonly thinkingLevel?: ThinkingLevel;
  /** Steering message delivery mode. Defaults to "all". */
  readonly steeringMode?: "all" | "one-at-a-time";
}

/**
 * Extended engine adapter with pi-specific lifecycle controls.
 * steer/followUp/abort delegate to the current active pi Agent instance.
 */
export interface PiEngineAdapter extends EngineAdapter {
  /** Interrupt the agent mid-run with a steering message. */
  readonly steer: (text: string) => void;
  /** Queue a follow-up message for after the agent finishes its current work. */
  readonly followUp: (text: string) => void;
  /** Abort the current agent run. */
  readonly abort: () => void;
}
