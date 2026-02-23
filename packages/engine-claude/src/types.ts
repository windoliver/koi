/**
 * Configuration and extended types for the Claude Agent SDK engine adapter.
 */

import type { EngineAdapter } from "@koi/core";

/**
 * Configuration for creating a Claude Agent SDK engine adapter.
 *
 * Uses Koi-native naming with an opaque `sdkOverrides` escape hatch
 * for advanced SDK-specific tuning.
 */
export interface ClaudeAdapterConfig {
  /** Model identifier (e.g., "claude-sonnet-4-5-20250929"). */
  readonly model?: string;
  /** Maximum conversation turns before stopping. */
  readonly maxTurns?: number;
  /** Maximum budget in USD for the query. */
  readonly maxBudgetUsd?: number;
  /** Working directory for the SDK subprocess. */
  readonly cwd?: string;
  /** Custom system prompt. */
  readonly systemPrompt?: string;
  /** SDK permission mode. Mapped from Koi permissions config. */
  readonly permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  /** Allowed built-in SDK tools (e.g., ["Read", "Edit", "Bash", "Glob", "Grep"]). */
  readonly allowedTools?: readonly string[];
  /** Disallowed built-in SDK tools. */
  readonly disallowedTools?: readonly string[];
  /**
   * Opaque SDK-specific overrides. Merged last into SDK Options.
   * Use for advanced tuning without leaking SDK types into the adapter API.
   */
  readonly sdkOverrides?: Readonly<Record<string, unknown>>;
}

/**
 * Internal state tracked across calls for session resumption.
 */
export interface ClaudeSessionState {
  readonly sessionId: string | undefined;
}

// ---------------------------------------------------------------------------
// SDK Query Controls
// ---------------------------------------------------------------------------

/**
 * Control methods available on an active Claude SDK query.
 *
 * These proxy the real SDK `Query` object's control methods.
 * Only available while a `stream()` call is active.
 */
export interface ClaudeQueryControls {
  /** Interrupt the current turn (keeps the session alive). */
  readonly interrupt: () => Promise<void>;
  /** Change the model for subsequent turns. */
  readonly setModel: (model?: string) => Promise<void>;
  /** Change the SDK permission mode. */
  readonly setPermissionMode: (mode: string) => Promise<void>;
  /** Stop a specific background task by ID. */
  readonly stopTask: (taskId: string) => Promise<void>;
}

/**
 * Extended engine adapter that exposes Claude SDK query controls.
 *
 * L0 consumers see plain `EngineAdapter` — no vendor leak.
 * L2 consumers importing from `@koi/engine-claude` get the wider type
 * with `.controls` available during active streams.
 */
export interface ClaudeEngineAdapter extends EngineAdapter {
  /** Available only while a stream() is active. undefined otherwise. */
  readonly controls: ClaudeQueryControls | undefined;
}
