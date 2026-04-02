/**
 * Hook contract — L0 types for session-scoped side-effect triggers.
 *
 * Hooks fire in response to session lifecycle events. Two transport types
 * are supported in Phase 1: `command` (local process via Bun.spawn) and
 * `http` (network request). The `prompt` type is deferred.
 *
 * Phase 1 scope: type definitions (this file), loader, schema validation,
 * and session-scoped registry (@koi/hooks). Engine-level integration
 * (automatic dispatch during session lifecycle) is separate work.
 */

import type { JsonObject } from "./common.js";

// ---------------------------------------------------------------------------
// Hook type discriminator
// ---------------------------------------------------------------------------

/** Supported hook transport types. */
export type HookType = "command" | "http";

// ---------------------------------------------------------------------------
// Hook event kind — typed lifecycle event discriminator
// ---------------------------------------------------------------------------

/** Canonical list of hook lifecycle events. Single source of truth. */
export const HOOK_EVENT_KINDS = [
  "session.started",
  "session.ended",
  "turn.started",
  "turn.ended",
  "tool.before",
  "tool.succeeded",
  "tool.failed",
  "permission.request",
  "permission.denied",
  "compact.before",
  "compact.after",
  "subagent.started",
  "subagent.stopped",
  "config.changed",
] as const;

/** Typed hook lifecycle event discriminator (known events). */
export type HookEventKind = (typeof HOOK_EVENT_KINDS)[number];

/**
 * Event kind accepted by hook interfaces. Known `HookEventKind` values get
 * autocomplete, but any string is accepted for forward compatibility with
 * newer event kinds and custom/third-party events.
 */
export type HookEventName = HookEventKind | (string & {});

// ---------------------------------------------------------------------------
// Hook filter — controls which events trigger a hook
// ---------------------------------------------------------------------------

/**
 * Filter conditions for hook dispatch. All specified fields must match (AND).
 * Within a field, any value can match (OR).
 *
 * When no filter is set on a hook config, the hook fires on all events.
 */
export interface HookFilter {
  /** Session event kinds to match (e.g., "session.started", "tool.succeeded"). */
  readonly events?: readonly HookEventName[] | undefined;
  /** Tool names to match. */
  readonly tools?: readonly string[] | undefined;
  /** Channel IDs to match. */
  readonly channels?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Hook event — the payload passed to hook executors
// ---------------------------------------------------------------------------

/**
 * Context passed to hook executors when a hook fires.
 */
export interface HookEvent {
  /** The event kind that triggered this hook (e.g., "session.started"). */
  readonly event: HookEventName;
  /** Agent ID that owns the session. */
  readonly agentId: string;
  /** Session ID. */
  readonly sessionId: string;
  /** Tool name, if the event is tool-related. */
  readonly toolName?: string | undefined;
  /** Channel ID, if the event is channel-related. */
  readonly channelId?: string | undefined;
  /** Arbitrary event data. */
  readonly data?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// Command hook config
// ---------------------------------------------------------------------------

/**
 * A hook that spawns a local process via `Bun.spawn`.
 *
 * The command receives hook event data as a JSON string via stdin.
 * The process is killed (SIGTERM) when the session ends or on timeout.
 */
export interface CommandHookConfig {
  readonly kind: "command";
  /** Human-readable hook name (unique within a manifest). */
  readonly name: string;
  /** Command and arguments to spawn (e.g., ["./scripts/on-start.sh", "--verbose"]). */
  readonly cmd: readonly string[];
  /** Optional environment variables for the spawned process. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Filter conditions — when absent, fires on all events. */
  readonly filter?: HookFilter | undefined;
  /** Whether this hook is active. Default: true. */
  readonly enabled?: boolean | undefined;
  /** Timeout in milliseconds. Default: 30_000. */
  readonly timeoutMs?: number | undefined;
  /** When true, this hook blocks subsequent serial hooks. Default: false (parallel). */
  readonly serial?: boolean | undefined;
  /**
   * Post-execution failure behavior. Default: true (fail-closed).
   *
   * This flag only affects post-tool hook failures. Pre-hook failures are
   * always fail-open (treated as "no opinion") to avoid availability risk.
   *
   * When true: if this hook fails during post-tool execution, the tool's
   * raw output is suppressed (replaced with a redaction notice). Use for
   * security-critical hooks like output redaction/scrubbing.
   *
   * When false: if this hook fails post-execution, the tool's output is
   * preserved with taint metadata. Use for observational/telemetry hooks
   * where suppressing committed output would cause retry risk.
   */
  readonly failClosed?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// HTTP hook config
// ---------------------------------------------------------------------------

/**
 * A hook that sends an HTTP request to a URL.
 *
 * The hook event data is sent as the JSON request body.
 * Supports HMAC-SHA256 signing (same pattern as outbound webhooks).
 */
export interface HttpHookConfig {
  readonly kind: "http";
  /** Human-readable hook name (unique within a manifest). */
  readonly name: string;
  /** Target URL. Must be HTTPS (HTTP allowed for localhost in dev). */
  readonly url: string;
  /** HTTP method. Default: "POST". */
  readonly method?: "POST" | "PUT" | undefined;
  /** Additional request headers. Supports env-var substitution (e.g., "${TOKEN}"). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** HMAC-SHA256 signing secret. Supports env-var substitution. */
  readonly secret?: string | undefined;
  /** Filter conditions — when absent, fires on all events. */
  readonly filter?: HookFilter | undefined;
  /** Whether this hook is active. Default: true. */
  readonly enabled?: boolean | undefined;
  /** Timeout in milliseconds. Default: 30_000. */
  readonly timeoutMs?: number | undefined;
  /** When true, this hook blocks subsequent serial hooks. Default: false (parallel). */
  readonly serial?: boolean | undefined;
  /**
   * Post-execution failure behavior. Default: true (fail-closed).
   *
   * This flag only affects post-tool hook failures. Pre-hook failures are
   * always fail-open (treated as "no opinion") to avoid availability risk.
   *
   * When true: if this hook fails during post-tool execution, the tool's
   * raw output is suppressed (replaced with a redaction notice). Use for
   * security-critical hooks like output redaction/scrubbing.
   *
   * When false: if this hook fails post-execution, the tool's output is
   * preserved with taint metadata. Use for observational/telemetry hooks
   * where suppressing committed output would cause retry risk.
   */
  readonly failClosed?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/** Discriminated union of all hook config types. */
export type HookConfig = CommandHookConfig | HttpHookConfig;

// ---------------------------------------------------------------------------
// Hook decision — structured response from hook executors
// ---------------------------------------------------------------------------

/**
 * Decision returned by a hook execution, expressing the hook's intent.
 *
 * Hooks return one of:
 * - `continue` — no opinion, proceed normally (default when no response)
 * - `block` — stop this operation with a reason visible to the model
 * - `modify` — patch the operation's input before proceeding
 */
export type HookDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "modify"; readonly patch: JsonObject };

// ---------------------------------------------------------------------------
// Hook execution result
// ---------------------------------------------------------------------------

/** Outcome of a single hook execution. */
export type HookExecutionResult =
  | {
      readonly ok: true;
      readonly hookName: string;
      readonly durationMs: number;
      readonly decision: HookDecision;
    }
  | {
      readonly ok: false;
      readonly hookName: string;
      readonly error: string;
      readonly durationMs: number;
      /** Whether this hook's failure should suppress output. Default: true. */
      readonly failClosed?: boolean | undefined;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default hook timeout in milliseconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000 as const;
