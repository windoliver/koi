/**
 * Hook contract — L0 types for session-scoped side-effect triggers.
 *
 * Hooks fire in response to session lifecycle events. Three transport types:
 * - `command` — local process via Bun.spawn
 * - `http` — network request (HTTPS, loopback HTTP in dev)
 * - `agent` — sub-agent LLM loop for verification/policy enforcement
 */

import type { JsonObject } from "./common.js";

// ---------------------------------------------------------------------------
// Hook type discriminator
// ---------------------------------------------------------------------------

/** Supported hook transport types. */
export type HookType = "command" | "http" | "agent";

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
  "compact.blocked",
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
  /** Env vars this hook is allowed to reference via ${VAR} expansion. */
  readonly allowedEnvVars?: readonly string[] | undefined;
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
// Prompt hook config
// ---------------------------------------------------------------------------

/**
 * A hook that makes a single-shot LLM call (~100-200 tokens) for pass/fail
 * verification. Fills the gap between static hooks (command/http) and expensive
 * agent hooks (4000+ tokens).
 *
 * The model receives a verification prompt and must respond with structured
 * JSON: `{ "ok": true/false, "reason": "..." }`.
 */
export interface PromptHookConfig {
  readonly kind: "prompt";
  /** Human-readable hook name (unique within a manifest). */
  readonly name: string;
  /** Verification prompt sent to the model. */
  readonly prompt: string;
  /** Override model for the verification call (default: cheap/fast model). */
  readonly model?: string | undefined;
  /** Timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  /** Max tokens for the verification response. Default: 256. */
  readonly maxTokens?: number | undefined;
  /** Filter conditions — when absent, fires on all events. */
  readonly filter?: HookFilter | undefined;
  /** Whether this hook is active. Default: true. */
  readonly enabled?: boolean | undefined;
  /** When true, this hook blocks subsequent serial hooks. Default: false (parallel). */
  readonly serial?: boolean | undefined;
  /**
   * Post-execution failure behavior. Default: true (fail-closed).
   *
   * When true: if the model response cannot be parsed, the action is blocked.
   * When false: if parsing fails, the action is allowed through (fail-open).
   */
  readonly failClosed?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Hook redaction config — controls payload forwarding to agent hooks
// ---------------------------------------------------------------------------

/**
 * Redaction options for event data forwarded to agent hook prompts.
 *
 * Only meaningful when `forwardRawPayload` is true on an `AgentHookConfig`.
 * When raw payload forwarding is enabled, detected secrets are redacted
 * by default unless `enabled` is explicitly set to false.
 */
export interface HookRedactionConfig {
  /** Whether to apply secret redaction to forwarded data. Default: true. */
  readonly enabled?: boolean | undefined;
  /** Censor strategy for detected secrets. Default: "redact". */
  readonly censor?: "redact" | "mask" | "remove" | undefined;
  /** Additional field names to treat as sensitive (exact match, case-insensitive). */
  readonly sensitiveFields?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Agent hook config
// ---------------------------------------------------------------------------

/**
 * A hook that spawns a sub-agent (LLM loop) to verify conditions.
 *
 * The sub-agent runs in non-interactive mode with a restricted tool set
 * and must return a structured verdict via the HookVerdict synthetic tool.
 * Agent hooks default to fail-closed: if the sub-agent times out or errors,
 * the operation is blocked.
 *
 * Agent hooks produce `continue` or `block` decisions only — `modify` is
 * not supported because LLMs cannot reliably produce JSON patches.
 */
export interface AgentHookConfig {
  readonly kind: "agent";
  /** Human-readable hook name (unique within a manifest). */
  readonly name: string;
  /** Instructions for the verification sub-agent. */
  readonly prompt: string;
  /** Override model for the sub-agent (default: cheap/fast model). */
  readonly model?: string | undefined;
  /** Override system prompt (default: verification-focused prompt). */
  readonly systemPrompt?: string | undefined;
  /** Timeout in milliseconds. Default: 60_000. */
  readonly timeoutMs?: number | undefined;
  /** Maximum assistant turns for the sub-agent loop. Default: 10. */
  readonly maxTurns?: number | undefined;
  /** Max tokens per model call for the sub-agent. Default: 4_096. */
  readonly maxTokens?: number | undefined;
  /** Cumulative token budget across all invocations in a session. Default: 50_000. */
  readonly maxSessionTokens?: number | undefined;
  /** Tools to exclude from the sub-agent (in addition to default denylist). */
  readonly toolDenylist?: readonly string[] | undefined;
  /**
   * Controls how event.data is forwarded to the hook agent prompt.
   *
   * - `true` (default): forward the full payload with secret redaction applied.
   *   Preserves values so content-based policies (commands, SQL, paths) work.
   * - `false`: forward structural summary only (keys + type placeholders, no values).
   *   Maximum privacy but hooks cannot inspect actual content.
   *
   * Default: true.
   */
  readonly forwardRawPayload?: boolean | undefined;
  /**
   * Redaction configuration for event data forwarded to the hook agent.
   * Applied when `forwardRawPayload` is true (the default).
   * Default: `{ enabled: true, censor: "redact" }`.
   */
  readonly redaction?: HookRedactionConfig | undefined;
  /** Filter conditions — when absent, fires on all events. */
  readonly filter?: HookFilter | undefined;
  /** Whether this hook is active. Default: true. */
  readonly enabled?: boolean | undefined;
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
export type HookConfig = CommandHookConfig | HttpHookConfig | PromptHookConfig | AgentHookConfig;

// ---------------------------------------------------------------------------
// Env-var policy — system-wide allowlist for hook env-var expansion
// ---------------------------------------------------------------------------

/**
 * System-wide policy controlling which env vars hooks may access
 * via `${VAR}` expansion in headers and secrets.
 *
 * Patterns support simple glob wildcards (`*` and `?`).
 * A var must match at least one pattern to be expandable.
 * When combined with per-hook `allowedEnvVars`, a var must pass both.
 */
export interface HookEnvPolicy {
  readonly allowedPatterns: readonly string[];
}

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
 * - `transform` — patch the operation's output after execution (PostToolUse only).
 *   `outputPatch` is shallow-merged into the tool response output (or replaces
 *   it when the output is not a plain object). Optional `metadata` is merged
 *   into the response metadata for additional context injection.
 */
export type HookDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "modify"; readonly patch: JsonObject }
  | {
      readonly kind: "transform";
      readonly outputPatch: JsonObject;
      readonly metadata?: JsonObject;
    };

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

/** Default hook timeout in milliseconds (command + http). */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000 as const;

/** Default agent hook timeout in milliseconds. */
export const DEFAULT_AGENT_HOOK_TIMEOUT_MS = 60_000 as const;

/** Default maximum assistant turns for agent hooks. */
export const DEFAULT_AGENT_MAX_TURNS = 10 as const;

/** Default max tokens per model call for agent hooks. */
export const DEFAULT_AGENT_MAX_TOKENS = 4_096 as const;

/**
 * Default cumulative token budget per session for agent hooks.
 * Sized for ~12 worst-case invocations at default settings (10 turns * 4096 tokens).
 */
export const DEFAULT_AGENT_SESSION_TOKEN_BUDGET = 500_000 as const;
