/**
 * Hook executor — dispatches matching hooks with parallel/serial execution.
 *
 * Uses AbortSignal.any() to compose per-hook timeouts with session-level
 * cancellation. Command hooks spawn via Bun.spawn; HTTP hooks use fetch.
 */

import type {
  CommandHookConfig,
  HookConfig,
  HookDecision,
  HookEvent,
  HookExecutionResult,
  HttpHookConfig,
  JsonObject,
} from "@koi/core";
import { DEFAULT_HOOK_TIMEOUT_MS as TIMEOUT_DEFAULT } from "@koi/core";
import { expandEnvVars, expandEnvVarsInRecord } from "./env.js";
import { matchesHookFilter } from "./filter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period (ms) between SIGTERM and SIGKILL for stubborn child processes. */
const SIGKILL_GRACE_MS = 2_000;

/**
 * Runtime URL policy enforcement — rejects URLs that violate the HTTPS/loopback
 * boundary. This is intentionally duplicated from the Zod schema to enforce the
 * policy even when callers construct HookConfig programmatically without going
 * through loadHooks().
 */
function validateHookUrl(url: string): string | undefined {
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
// Hook decision parsing
// ---------------------------------------------------------------------------

const DECISION_CONTINUE: HookDecision = { kind: "continue" } as const;

/**
 * Parse raw hook output (stdout or HTTP response body) into a HookDecision.
 *
 * Expected JSON shape:
 *   { "decision": "continue" }
 *   { "decision": "block", "reason": "..." }
 *   { "decision": "modify", "patch": { ... } }
 *
 * Returns `{ kind: "continue" }` when the output is empty, not JSON, or
 * doesn't match the expected shape — hooks that don't return a decision
 * are treated as having no opinion.
 */
function parseHookDecision(raw: string): HookDecision {
  const trimmed = raw.trim();
  if (trimmed === "") return DECISION_CONTINUE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return DECISION_CONTINUE;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return DECISION_CONTINUE;
  }

  const obj = parsed as Record<string, unknown>;
  const decision = obj.decision;

  if (decision === "block") {
    const reason = typeof obj.reason === "string" ? obj.reason : "blocked by hook";
    return { kind: "block", reason };
  }

  if (decision === "modify") {
    if (typeof obj.patch === "object" && obj.patch !== null && !Array.isArray(obj.patch)) {
      return { kind: "modify", patch: obj.patch as JsonObject };
    }
    return DECISION_CONTINUE;
  }

  return DECISION_CONTINUE;
}

// ---------------------------------------------------------------------------
// Single-hook executors
// ---------------------------------------------------------------------------

/**
 * Forcefully kill a process: SIGTERM first, then SIGKILL after a grace period
 * if the process doesn't exit. Returns a promise that resolves when the
 * process is confirmed dead.
 */
async function forceKill(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  proc.kill(); // SIGTERM
  const exited = await Promise.race([
    proc.exited.then(() => true as const),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), SIGKILL_GRACE_MS)),
  ]);
  if (!exited) {
    proc.kill(9); // SIGKILL
  }
}

async function executeCommandHook(
  hook: CommandHookConfig,
  event: HookEvent,
  signal: AbortSignal,
): Promise<HookExecutionResult> {
  const start = performance.now();
  try {
    signal.throwIfAborted();

    const spawnOptions: {
      readonly stdin: ReadableStream<Uint8Array> | null;
      readonly stdout: "pipe";
      readonly stderr: "pipe";
      readonly env?: Record<string, string | undefined>;
    } = {
      stdin: new Response(JSON.stringify(event)).body,
      stdout: "pipe",
      stderr: "pipe",
    };

    const proc = Bun.spawn(
      hook.cmd as string[],
      hook.env !== undefined
        ? { ...spawnOptions, env: { ...process.env, ...hook.env } }
        : spawnOptions,
    );

    // Wire up abort signal to force-kill the process (SIGTERM → SIGKILL)
    const onAbort = (): void => {
      void forceKill(proc);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Close the spawn/abort race: if the signal fired between Bun.spawn()
    // and addEventListener(), the listener missed it. Check and kill now.
    if (signal.aborted) {
      void forceKill(proc);
    }

    // Drain stdout + stderr concurrently with waiting for exit to avoid pipe buffer deadlock
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    signal.removeEventListener("abort", onAbort);

    const durationMs = performance.now() - start;

    if (signal.aborted) {
      return {
        ok: false,
        hookName: hook.name,
        error: "aborted",
        durationMs,
        failClosed: hook.failClosed,
      };
    }

    if (exitCode !== 0) {
      return {
        ok: false,
        hookName: hook.name,
        error: `exit code ${exitCode}: ${stderrText.slice(0, 500)}`,
        durationMs,
        failClosed: hook.failClosed,
      };
    }

    const decision = parseHookDecision(stdoutText);
    return { ok: true, hookName: hook.name, durationMs, decision };
  } catch (e: unknown) {
    const durationMs = performance.now() - start;
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      hookName: hook.name,
      error: message,
      durationMs,
      failClosed: hook.failClosed,
    };
  }
}

async function executeHttpHook(
  hook: HttpHookConfig,
  event: HookEvent,
  signal: AbortSignal,
): Promise<HookExecutionResult> {
  const start = performance.now();
  try {
    signal.throwIfAborted();

    // Runtime URL policy — catches programmatic callers bypassing loadHooks()
    const urlError = validateHookUrl(hook.url);
    if (urlError !== undefined) {
      const durationMs = performance.now() - start;
      return {
        ok: false,
        hookName: hook.name,
        error: `URL rejected: ${urlError}`,
        durationMs,
        failClosed: hook.failClosed,
      };
    }

    const expandedHeaders =
      hook.headers !== undefined ? expandEnvVarsInRecord(hook.headers) : undefined;
    if (expandedHeaders !== undefined && !expandedHeaders.ok) {
      const durationMs = performance.now() - start;
      return {
        ok: false,
        hookName: hook.name,
        error: `unresolved env vars in headers: ${expandedHeaders.missing.join(", ")}`,
        durationMs,
        failClosed: hook.failClosed,
      };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(expandedHeaders?.value ?? {}),
    };

    // HMAC-SHA256 signing if secret is provided
    if (hook.secret !== undefined) {
      const resolvedSecret = expandEnvVars(hook.secret);
      if (!resolvedSecret.ok) {
        const durationMs = performance.now() - start;
        return {
          ok: false,
          hookName: hook.name,
          error: `unresolved env vars in secret: ${resolvedSecret.missing.join(", ")}`,
          durationMs,
          failClosed: hook.failClosed,
        };
      }
      const body = JSON.stringify(event);
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(resolvedSecret.value),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
      headers["X-Hook-Signature"] = `sha256=${Buffer.from(sig).toString("hex")}`;
    }

    // Block redirects to prevent SSRF — a 30x redirect could
    // send the event payload to an arbitrary HTTP endpoint, bypassing the
    // HTTPS/localhost validation enforced at schema level.
    const response = await fetch(hook.url, {
      method: hook.method ?? "POST",
      headers,
      body: JSON.stringify(event),
      signal,
      redirect: "error",
    });

    const durationMs = performance.now() - start;

    if (!response.ok) {
      return {
        ok: false,
        hookName: hook.name,
        error: `HTTP ${response.status}: ${response.statusText}`,
        durationMs,
        failClosed: hook.failClosed,
      };
    }

    const body = await response.text();
    const decision = parseHookDecision(body);
    return { ok: true, hookName: hook.name, durationMs, decision };
  } catch (e: unknown) {
    const durationMs = performance.now() - start;
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      hookName: hook.name,
      error: message,
      durationMs,
      failClosed: hook.failClosed,
    };
  }
}

// ---------------------------------------------------------------------------
// Dispatch a single hook with its own composed abort signal
// ---------------------------------------------------------------------------

function executeSingleHook(
  hook: HookConfig,
  event: HookEvent,
  sessionSignal: AbortSignal | undefined,
): Promise<HookExecutionResult> {
  const timeoutMs = hook.timeoutMs ?? TIMEOUT_DEFAULT;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (sessionSignal !== undefined) {
    signals.push(sessionSignal);
  }
  const composedSignal = AbortSignal.any(signals);

  switch (hook.kind) {
    case "command":
      return executeCommandHook(hook, event, composedSignal);
    case "http":
      return executeHttpHook(hook, event, composedSignal);
    default: {
      const _exhaustive: never = hook;
      throw new Error(`Unknown hook kind: ${(_exhaustive as HookConfig).kind}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute hooks that match the given event.
 *
 * Hooks run in declaration order. Contiguous parallel hooks (serial !== true)
 * are batched and run concurrently via Promise.allSettled. Serial hooks run
 * one at a time, flushing any pending parallel batch first.
 *
 * @param hooks - All hooks to consider (pre-filtered to active only)
 * @param event - The event that triggered execution
 * @param sessionSignal - Optional session-level abort signal for cancellation
 * @returns Results for all matching hooks, in declaration order
 */
export async function executeHooks(
  hooks: readonly HookConfig[],
  event: HookEvent,
  sessionSignal?: AbortSignal | undefined,
): Promise<readonly HookExecutionResult[]> {
  const matching = hooks.filter((h) => matchesHookFilter(h.filter, event));
  if (matching.length === 0) {
    return [];
  }

  const results: HookExecutionResult[] = [];
  let parallelBatch: Array<{ readonly hook: HookConfig; readonly index: number }> = [];

  // Flush a batch of parallel hooks, writing results at their original indices
  const flushParallel = async (): Promise<void> => {
    if (parallelBatch.length === 0) return;
    const settled = await Promise.allSettled(
      parallelBatch.map((entry) => executeSingleHook(entry.hook, event, sessionSignal)),
    );
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const entry = parallelBatch[i];
      if (s === undefined || entry === undefined) continue;
      results[entry.index] =
        s.status === "fulfilled"
          ? s.value
          : {
              ok: false as const,
              hookName: entry.hook.name,
              error: s.reason instanceof Error ? s.reason.message : String(s.reason),
              durationMs: 0,
              failClosed: entry.hook.failClosed,
            };
    }
    parallelBatch = [];
  };

  for (let i = 0; i < matching.length; i++) {
    const hook = matching[i];
    if (hook === undefined) continue;

    if (hook.serial === true) {
      // Flush any pending parallel batch before running serial hook
      await flushParallel();
      results[i] = await executeSingleHook(hook, event, sessionSignal);
    } else {
      parallelBatch.push({ hook, index: i });
    }
  }

  // Flush trailing parallel batch
  await flushParallel();

  return results;
}
