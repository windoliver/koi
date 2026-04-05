import { spawn as spawnChild } from "node:child_process";
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
 * Security:
 * - classifyBashCommand() runs: allowlist → injection → path → command
 * - Spawn uses `bash --noprofile --norc` to prevent profile-based escalation
 * - `set -euo pipefail` is prepended to every command string
 * - Environment is replaced with a minimal safe set (no inherited env vars)
 * - AbortSignal is wired to SIGTERM with SIGKILL escalation after 3s
 * - Output is capped at BashPolicy.maxOutputBytes (default 1 MB)
 */
export function createBashTool(config?: BashToolConfig): Tool {
  // workspaceRoot gates cwd containment.  When omitted the cwd is still
  // validated against process.cwd() so the tool is never fully unconstrained:
  // a caller that does not set workspaceRoot gets process.cwd() as the fence.
  const workspaceRoot = config?.workspaceRoot ?? process.cwd();
  const policy: BashPolicy = {
    ...DEFAULT_BASH_POLICY,
    ...config?.policy,
  };
  const maxOutputBytes = policy.maxOutputBytes ?? DEFAULT_BASH_POLICY.maxOutputBytes ?? 1_048_576;
  const defaultTimeoutMs =
    policy.defaultTimeoutMs ?? DEFAULT_BASH_POLICY.defaultTimeoutMs ?? 30_000;

  return {
    descriptor: {
      name: "Bash",
      description:
        "Execute a bash command. Commands are validated against security classifiers " +
        "before execution. Dangerous patterns (reverse shells, privilege escalation, " +
        "injection vectors) are blocked. Use cwd to set the working directory.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the command. Must be within the workspace root. " +
              "Defaults to workspace root. Note: file path arguments inside the command " +
              "string are not additionally validated — use absolute paths under the workspace.",
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

      const cwd = typeof args.cwd === "string" ? args.cwd : workspaceRoot;
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : defaultTimeoutMs;

      // Security classification pipeline (allowlist → injection → path → command)
      // workspaceRoot is always set (defaults to process.cwd()) so containment
      // is always enforced — cwd must resolve inside workspaceRoot.
      const classifyOpts = {
        cwd,
        policy,
        workspaceRoot,
      };
      const classification = classifyBashCommand(command, classifyOpts);
      if (!classification.ok) {
        return {
          error: "Command blocked by security policy",
          category: classification.category,
          reason: classification.reason,
          pattern: classification.pattern,
        };
      }

      return spawnBash(command, cwd, timeoutMs, maxOutputBytes, signal);
    },
  };
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
  const proc = spawnChild(
    "bash",
    ["--noprofile", "--norc", "-c", `set -euo pipefail\n${command}`],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: SAFE_ENV,
      detached: true,
    },
  );

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
  const budget = { remaining: maxOutputBytes };
  const exited = new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 1));
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
