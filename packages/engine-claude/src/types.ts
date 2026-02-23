/**
 * Configuration and extended types for the Claude Agent SDK engine adapter.
 */

import type { ApprovalHandler, EngineAdapter, JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// HITL custom event constants
// ---------------------------------------------------------------------------

/**
 * Custom event type constants for human-in-the-loop signaling.
 *
 * Emitted as `{ kind: "custom", type: HITL_EVENTS.*, data: HitlRequestData }`.
 * Observable for telemetry/UI — never required for correctness.
 */
export const HITL_EVENTS = {
  /** Emitted when a tool approval request is sent to the handler. */
  REQUEST: "hitl_request",
  /** Emitted when an approval response is received from the handler. */
  RESPONSE_RECEIVED: "hitl_response_received",
  /** Emitted when the approval handler throws (fail-closed: denied). */
  ERROR: "hitl_error",
} as const;

/**
 * Typed data payload for HITL custom events.
 */
export interface HitlRequestData {
  readonly kind: "tool_approval" | "question";
  readonly toolName?: string;
  readonly input?: JsonObject;
  readonly question?: string;
  readonly metadata?: JsonObject;
}

// ---------------------------------------------------------------------------
// SDK canUseTool bridge types
// ---------------------------------------------------------------------------

/**
 * SDK permission result shape (structural — avoids importing SDK types).
 */
export interface SdkPermissionResult {
  readonly behavior: "allow" | "deny";
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly message?: string;
}

/**
 * SDK canUseTool callback shape (structural — avoids importing SDK types).
 */
export type SdkCanUseTool = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
) => Promise<SdkPermissionResult>;

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

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
  /**
   * Koi approval handler for tool-use gating (HITL).
   * When provided, the adapter bridges this to the SDK's `canUseTool` callback.
   * Fail-closed: handler errors result in deny.
   */
  readonly approvalHandler?: ApprovalHandler;
  /**
   * HITL configuration options.
   */
  readonly hitl?: {
    /** Maximum message queue size (default: 100). */
    readonly maxQueueSize?: number;
  };
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
 * Extended engine adapter that exposes Claude SDK query controls
 * and human-in-the-loop message injection.
 *
 * L0 consumers see plain `EngineAdapter` — no vendor leak.
 * L2 consumers importing from `@koi/engine-claude` get the wider type
 * with `.controls` and `.saveHumanMessage()` available.
 */
export interface ClaudeEngineAdapter extends EngineAdapter {
  /** Available only while a stream() is active. undefined otherwise. */
  readonly controls: ClaudeQueryControls | undefined;
  /**
   * Inject a human message into the active conversation.
   *
   * - If streaming: pushes to the active message queue (delivered to SDK).
   * - If idle: buffers for the next stream() call.
   * - If disposed: no-op with console.warn.
   *
   * Fire-and-forget — returns void.
   */
  readonly saveHumanMessage: (text: string) => void;
}
