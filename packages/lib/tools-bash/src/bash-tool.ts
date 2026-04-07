import { spawn as spawnChild } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { type BashPolicy, classifyBashCommand, DEFAULT_BASH_POLICY } from "@koi/bash-security";
import type { JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

/** Grace period before escalating SIGTERM to SIGKILL on cancellation. */
const SIGKILL_ESCALATION_MS = 3_000;

/** Safe minimal environment for spawned bash processes. */
const SAFE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "dumb",
} as const;

// ---------------------------------------------------------------------------
// SpawnTransform — argv-based sandbox injection hook
// ---------------------------------------------------------------------------

/** Input to a spawn transform — the base argv, cwd, and env before spawning. */
export interface SpawnTransformInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Output from a spawn transform — the transformed argv, cwd, and env to spawn with. */
export interface SpawnTransformOutput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Transform applied before subprocess spawn. Used for OS-level sandboxing.
 *
 * Receives the base argv (e.g. `["bash", "--noprofile", "--norc", "-c", "..."]`),
 * cwd, and env. Returns transformed values — e.g. prepending `sandbox-exec` or
 * `bwrap` to the argv, remapping cwd to a sandbox mount point, or extending env.
 *
 * Injected at L3 (`@koi/runtime`) to avoid L2→L2 layer violations.
 */
export type SpawnTransform = (input: SpawnTransformInput) => SpawnTransformOutput;

// ---------------------------------------------------------------------------
// BashToolConfig
// ---------------------------------------------------------------------------

export interface BashToolConfig {
  /**
   * Workspace root directory. Relative `cwd` arguments are resolved
   * against this path and must remain within it.
   *
   * Defaults to `process.cwd()`.
   */
  readonly workspaceRoot?: string;
  /** Security policy applied to every command. */
  readonly policy?: BashPolicy;
  /**
   * When true, the tool tracks the working directory across calls.
   * A `cd` in one command persists to the next. The tracked cwd is
   * only updated on successful execution (exit code 0).
   *
   * Uses a temp file with an EXIT trap — out-of-band, not spoofable
   * via stdout/stderr output.
   */
  readonly trackCwd?: boolean;
  /**
   * Optional spawn transform for OS-level sandboxing. Receives the base
   * argv/cwd/env and returns transformed values. Injected at L3.
   */
  readonly wrapCommand?: SpawnTransform;
}

/** Shape of the bash tool's JSON output on success. */
interface BashSuccessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut?: true;
  readonly truncated?: true;
  readonly truncatedNote?: string;
  /** Current working directory after execution. Present when `trackCwd` is enabled. */
  readonly cwd?: string;
}

/** Shape of the bash tool's JSON output when the command is blocked. */
interface BashBlockedResult {
  readonly error: string;
  readonly category: string;
  readonly reason: string;
  readonly pattern: string;
}

type BashResult = BashSuccessResult | BashBlockedResult;

/**
 * Create a bash execution tool that guards every command through the
 * @koi/bash-security classifier pipeline before spawning.
 *
 * Security model (what IS enforced):
 * - classifyBashCommand() pipeline: allowlist → injection → path → command
 * - Spawn uses `bash --noprofile --norc` to prevent profile-based escalation
 * - `set -euo pipefail` is prepended to every command string
 * - Environment is replaced with a minimal safe set (no inherited env vars)
 * - Working directory (`cwd`) is validated against `workspaceRoot`
 * - AbortSignal wired to SIGTERM → SIGKILL (process group, all descendants)
 * - Output is capped at BashPolicy.maxOutputBytes (default 1 MB)
 *
 * Known limitation (what is NOT enforced):
 * - File path arguments *inside* the command string are NOT validated.
 *   A command like `cat /etc/passwd` passes even if cwd is within the workspace.
 *   This tool relies on the denylist (reverse shells, escalation, etc.) and the
 *   allowlist (if configured) for command-level control.  For full filesystem
 *   confinement inject an OS sandbox via `wrapCommand` at the L3 integration layer.
 */
export function createBashTool(config?: BashToolConfig): Tool {
  // workspaceRoot gates cwd containment.  When omitted the cwd is still
  // validated against process.cwd() so the tool is never fully unconstrained:
  // a caller that does not set workspaceRoot gets process.cwd() as the fence.
  const workspaceRoot = config?.workspaceRoot ?? process.cwd();
  const trackCwd = config?.trackCwd === true;
  const policy: BashPolicy = {
    ...DEFAULT_BASH_POLICY,
    ...config?.policy,
  };
  const maxOutputBytes = policy.maxOutputBytes ?? DEFAULT_BASH_POLICY.maxOutputBytes ?? 1_048_576;
  const defaultTimeoutMs =
    policy.defaultTimeoutMs ?? DEFAULT_BASH_POLICY.defaultTimeoutMs ?? 30_000;

  // Mutable tracked cwd — updated only on successful execution (exit 0).
  // Serialized: when trackCwd is on, execute() calls queue behind a promise
  // chain so concurrent calls cannot race on the shared cwd state.
  // Single-caller contract: each tool instance tracks ONE cwd. Do not share
  // a trackCwd-enabled tool across independent agents/sessions.
  // let justified: mutable state for cwd tracking across sequential tool calls
  let trackedCwd = workspaceRoot;
  // let justified: promise chain serializes execute() when trackCwd is on
  let pending: Promise<unknown> = Promise.resolve();

  const cwdDescription = trackCwd
    ? "Working directory for the command. Must be within the workspace root. " +
      "Defaults to the tracked cwd from the previous command (persists across calls)."
    : "Working directory for the command. Must be within the workspace root. " +
      "Defaults to workspace root. Note: file path arguments inside the command " +
      "string are not additionally validated — use absolute paths under the workspace.";

  return {
    descriptor: {
      name: "Bash",
      description:
        "Execute a bash command. The working directory is validated against the workspace root. " +
        "Known-dangerous patterns (reverse shells, privilege escalation, injection vectors) are " +
        "blocked by classifier. File path arguments inside the command string are NOT further " +
        "restricted — for full filesystem confinement use an OS sandbox via wrapCommand." +
        (trackCwd ? " CWD tracking is enabled — cd persists across calls." : ""),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          cwd: {
            type: "string",
            description: cwdDescription,
          },
          timeoutMs: {
            type: "number",
            description: `Execution timeout in milliseconds. Defaults to ${defaultTimeoutMs}ms.`,
          },
        },
        required: ["command"],
      } as JsonObject,
      tags: ["shell", "execution"],
    },
    origin: "primordial",
    // DEFAULT_UNSANDBOXED_POLICY: this tool intentionally runs without OS-level
    // sandboxing.  Callers that need confinement should inject wrapCommand in
    // BashToolConfig to run commands inside a sandbox (e.g. sandbox-exec, nsjail).
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<BashResult> => {
      const signal = options?.signal;
      signal?.throwIfAborted();

      const command = args.command;
      if (typeof command !== "string" || command.trim() === "") {
        return {
          error: "command must be a non-empty string",
          category: "injection",
          reason: "Empty or invalid command argument",
          pattern: "",
        };
      }

      // When trackCwd is off, run without serialization for zero overhead
      if (!trackCwd) {
        const cwd = typeof args.cwd === "string" ? args.cwd : workspaceRoot;
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : defaultTimeoutMs;
        const classification = classifyBashCommand(command, { cwd, policy, workspaceRoot });
        if (!classification.ok) {
          return {
            error: "Command blocked by security policy",
            category: classification.category,
            reason: classification.reason,
            pattern: classification.pattern,
          };
        }
        return spawnBash(command, cwd, timeoutMs, maxOutputBytes, signal, config?.wrapCommand);
      }

      // Serialize execution when trackCwd is on — prevents concurrent
      // callers from racing on the shared trackedCwd state.
      const prev = pending;
      // release is always assigned before await returns — safe to call in finally
      let release: (() => void) | undefined;
      pending = new Promise<void>((r) => {
        release = r;
      });
      await prev;

      try {
        const cwd = typeof args.cwd === "string" ? args.cwd : trackedCwd;
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : defaultTimeoutMs;

        const classification = classifyBashCommand(command, { cwd, policy, workspaceRoot });
        if (!classification.ok) {
          return {
            error: "Command blocked by security policy",
            category: classification.category,
            reason: classification.reason,
            pattern: classification.pattern,
          };
        }

        const cwdFile = join(tmpdir(), `koi-cwd-${crypto.randomUUID()}`);
        const wrappedCommand = `__koi_cwd_file=${shellQuote(cwdFile)}\ntrap 'pwd -P > "$__koi_cwd_file" 2>/dev/null' EXIT\n${command}`;

        const result = await spawnBash(
          wrappedCommand,
          cwd,
          timeoutMs,
          maxOutputBytes,
          signal,
          config?.wrapCommand,
        );

        // Read cwd from temp file and update tracked state (success-only)
        try {
          if ("exitCode" in result && result.exitCode === 0) {
            const newCwd = readCwdFile(cwdFile);
            if (newCwd !== undefined && isWithinWorkspace(newCwd, workspaceRoot)) {
              trackedCwd = newCwd;
            }
          }
        } finally {
          cleanupCwdFile(cwdFile);
        }

        if ("exitCode" in result) {
          return { ...result, cwd: trackedCwd };
        }
        return result;
      } finally {
        release?.();
      }
    },
  };
}

/** Shell-quote a string for safe embedding in bash (single-quote wrapping). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Read the cwd temp file. Returns undefined if missing or empty. */
function readCwdFile(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the cwd temp file. Best-effort, never throws. */
function cleanupCwdFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // File may not exist if trap didn't fire — acceptable
  }
}

/** Check if a path is within the workspace root (no traversal). */
function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
  const resolved = resolve(path);
  const root = resolve(workspaceRoot);
  return resolved === root || resolved.startsWith(`${root}/`);
}

/**
 * Spawn bash and collect output with AbortSignal support and output budgeting.
 * Not exported — internal to this module.
 *
 * Process group kill: `detached: true` puts bash in its own process group so
 * that `process.kill(-pid, signal)` terminates bash AND all descendants.
 * Without this, long-running child processes survive after the tool reports
 * completion/cancellation, creating a rollback hazard.
 */
async function spawnBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  wrapCommand?: SpawnTransform,
): Promise<BashResult> {
  const start = Date.now();

  // Build effective signal: combine caller signal + per-invocation timeout
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  const signals: AbortSignal[] = [timeoutController.signal];
  if (signal !== undefined) signals.push(signal);
  const effectiveSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  // Re-check after building signal — avoid spawn if already aborted
  if (effectiveSignal?.aborted) {
    clearTimeout(timer);
    signal?.throwIfAborted();
    return {
      error: "Operation cancelled before spawn",
      category: "injection",
      reason: "Cancelled",
      pattern: "",
    };
  }

  // detached: true (Unix) — bash starts as the leader of a new process group.
  // PGID == proc.pid, so `process.kill(-pid, sig)` kills every descendant.
  // --noprofile --norc: skip /etc/profile and ~/.bashrc to prevent profile-based code execution
  // set -euo pipefail: exit on error, unset vars, pipefail — fail-safe shell defaults
  const baseInput: SpawnTransformInput = {
    argv: ["bash", "--noprofile", "--norc", "-c", `set -euo pipefail\n${command}`],
    cwd,
    env: SAFE_ENV,
  };
  const spawnOpts = wrapCommand !== undefined ? wrapCommand(baseInput) : baseInput;
  const [cmd, ...args] = spawnOpts.argv;
  if (cmd === undefined) {
    return {
      error: "SpawnTransform returned empty argv",
      category: "injection",
      reason: "wrapCommand produced no command",
      pattern: "",
    };
  }
  const proc = spawnChild(cmd, args, {
    cwd: spawnOpts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnOpts.env,
    detached: true,
  });

  // Convert Node.js Readable to Web ReadableStream for drainStream
  const stdoutStream: ReadableStream<Uint8Array> | null =
    proc.stdout !== null ? (Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>) : null;
  const stderrStream: ReadableStream<Uint8Array> | null =
    proc.stderr !== null ? (Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>) : null;

  // Wire abort — kill the entire process group, not just the shell
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    const pid = proc.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGTERM"); // Negative PID targets the process group
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    killTimer = setTimeout(() => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }, SIGKILL_ESCALATION_MS);
  };
  effectiveSignal?.addEventListener("abort", onAbort, { once: true });

  // Guard against race: signal aborted between check and addEventListener
  if (effectiveSignal?.aborted) {
    onAbort();
  }

  // Collect stdout and stderr with a shared byte budget.
  // Both streams are drained concurrently to prevent pipe-buffer deadlock:
  // a subprocess blocked writing to a full pipe will never exit.
  //
  // 'error' handler is required: if bash cannot be spawned (e.g. the cwd path
  // does not exist on disk despite passing validatePath's fallback-to-resolve),
  // Node emits 'error' instead of 'exit'.  Without a listener that is an
  // uncaught exception; with one we capture the message and return a blocked result.
  const budget = { remaining: maxOutputBytes };
  let spawnError: Error | undefined;
  const exited = new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 1));
    proc.on("error", (err: Error) => {
      spawnError = err;
      resolve(1);
    });
  });
  const [stdoutResult, stderrResult] = await Promise.all([
    drainStream(stdoutStream, budget),
    drainStream(stderrStream, budget),
  ]);
  const exitCode = await exited;

  // Cleanup
  effectiveSignal?.removeEventListener("abort", onAbort);
  clearTimeout(timer);
  if (killTimer !== undefined) clearTimeout(killTimer);

  // Spawn failed (e.g. cwd does not exist) — return a blocked result rather
  // than a success with exit code 1, so callers can distinguish the two cases.
  if (spawnError !== undefined) {
    return {
      error: "Failed to spawn bash subprocess",
      category: "injection",
      reason: spawnError.message,
      pattern: "",
    };
  }

  const truncated = stdoutResult.truncated || stderrResult.truncated;
  const totalBytes = stdoutResult.byteCount + stderrResult.byteCount;

  return {
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    exitCode,
    durationMs: Date.now() - start,
    ...(timedOut ? { timedOut: true as const } : {}),
    ...(truncated
      ? {
          truncated: true as const,
          truncatedNote: `Output truncated at ${maxOutputBytes} bytes (${totalBytes} bytes total)`,
        }
      : {}),
  };
}

interface DrainResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly byteCount: number;
}

/**
 * Drain a ReadableStream into a string, respecting a shared byte budget.
 * Keeps draining after budget is exhausted to prevent pipe-buffer deadlock.
 */
async function drainStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  budget: { remaining: number },
): Promise<DrainResult> {
  if (stream == null) return { text: "", truncated: false, byteCount: 0 };

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  let truncated = false;
  let byteCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.length;

      if (budget.remaining <= 0) {
        // Budget exhausted — keep draining to unblock subprocess writes
        truncated = true;
        continue;
      }

      const chunk = value.length <= budget.remaining ? value : value.slice(0, budget.remaining);
      text += decoder.decode(chunk, { stream: true });
      budget.remaining -= chunk.length;

      if (value.length > chunk.length) {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated, byteCount };
}
