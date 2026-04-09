/**
 * Shared hook validation — URL policy, timeout resolution, fail mode defaults.
 *
 * Single source of truth for validation logic used by both Zod schemas
 * (parse-time) and executors (runtime). Prevents the two from drifting.
 */

import type { HookConfig } from "@koi/core";
import {
  DEFAULT_AGENT_HOOK_TIMEOUT_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_PROMPT_HOOK_TIMEOUT_MS,
} from "@koi/core";

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/**
 * Validate a hook URL against the HTTPS/loopback boundary.
 *
 * Returns `undefined` on success, or a human-readable error string on failure.
 * Used by both the Zod schema (parse-time) and the HTTP executor (runtime).
 */
export function validateHookUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return undefined;
    if (parsed.protocol === "http:") {
      const isDev =
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test" ||
        process.env.KOI_DEV === "1";
      if (!isDev) return "HTTP URLs require NODE_ENV=development or KOI_DEV=1";
      const host = parsed.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return undefined;
      return "HTTP URLs are only allowed for localhost/127.0.0.1/[::1]";
    }
    return `unsupported protocol: ${parsed.protocol}`;
  } catch {
    return "invalid URL";
  }
}

// ---------------------------------------------------------------------------
// Timeout resolution
// ---------------------------------------------------------------------------

/** Resolve the effective timeout for a hook config. */
export function resolveTimeout(hook: HookConfig): number {
  if (hook.timeoutMs !== undefined) return hook.timeoutMs;
  if (hook.kind === "agent") return DEFAULT_AGENT_HOOK_TIMEOUT_MS;
  if (hook.kind === "prompt") return DEFAULT_PROMPT_HOOK_TIMEOUT_MS;
  return DEFAULT_HOOK_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Fail mode resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective failClosed flag for a hook config.
 *
 * Defaults: all hook types → true (fail-closed). When true, hook failures
 * during post-tool execution suppress the tool's raw output. When false,
 * output is preserved with taint metadata.
 */
export function resolveFailMode(hook: HookConfig): boolean {
  if (hook.failClosed !== undefined) return hook.failClosed;
  return true;
}
