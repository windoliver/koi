/**
 * Hook type system — lifecycle hooks for agent manifests.
 *
 * Defines the 4 hook types (command, http, prompt, agent) and their
 * configuration, event, and executor contracts.
 */

import type { JsonObject } from "./common.js";

// ---------------------------------------------------------------------------
// Hook event kinds
// ---------------------------------------------------------------------------

export const HOOK_EVENT_KINDS = [
  "beforeToolCall",
  "afterToolCall",
  "beforeModelCall",
  "afterModelCall",
  "onError",
] as const;

export type HookEventKind = (typeof HOOK_EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Hook filter — selects which events a hook observes
// ---------------------------------------------------------------------------

export interface HookFilter {
  readonly events?: readonly HookEventKind[] | undefined;
  readonly toolNames?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Hook verdict — continue or block with reason
// ---------------------------------------------------------------------------

export type HookVerdict =
  | { readonly kind: "continue" }
  | { readonly kind: "block"; readonly reason: string };

// ---------------------------------------------------------------------------
// Hook type discriminant
// ---------------------------------------------------------------------------

export type HookType = "command" | "http" | "prompt" | "agent";

// ---------------------------------------------------------------------------
// Base config shared by all hook types
// ---------------------------------------------------------------------------

interface HookConfigBase {
  readonly name: string;
  readonly filter?: HookFilter | undefined;
  readonly enabled?: boolean | undefined;
  readonly serial?: boolean | undefined;
  readonly failMode?: "open" | "closed" | undefined;
}

// ---------------------------------------------------------------------------
// Per-kind config interfaces
// ---------------------------------------------------------------------------

export interface CommandHookConfig extends HookConfigBase {
  readonly kind: "command";
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface HttpHookConfig extends HookConfigBase {
  readonly kind: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface PromptHookConfig extends HookConfigBase {
  readonly kind: "prompt";
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface AgentHookConfig extends HookConfigBase {
  readonly kind: "agent";
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly toolDenylist?: readonly string[] | undefined;
}

/** Discriminated union of all hook config types. */
export type HookConfig =
  | CommandHookConfig
  | HttpHookConfig
  | PromptHookConfig
  | AgentHookConfig;

// ---------------------------------------------------------------------------
// Hook event — payload delivered to hook executors
// ---------------------------------------------------------------------------

export interface HookEvent {
  readonly kind: HookEventKind;
  readonly toolName?: string | undefined;
  readonly data?: JsonObject | undefined;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Hook executor — generic executor contract keyed by config type
// ---------------------------------------------------------------------------

export interface HookExecutor<C extends HookConfig> {
  readonly kind: C["kind"];
  readonly execute: (config: C, event: HookEvent) => Promise<HookVerdict>;
  readonly dispose?: () => Promise<void> | void;
}
