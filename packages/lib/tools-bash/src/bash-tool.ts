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
  // workspaceRoot is optional — when provided, cwd is validated against it.
  // When omitted, no containment check is performed.
  const workspaceRoot = config?.workspaceRoot;
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
              "Defaults to workspace root.",
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

      const cwd = typeof args.cwd === "string" ? args.cwd : (workspaceRoot ?? process.cwd());
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : defaultTimeoutMs;

      // Security classification pipeline (allowlist → injection → path → command)
      // exactOptionalPropertyTypes: build opts without undefined fields
      const classifyOpts = {
        cwd,
        ...(policy !== undefined ? { policy } : {}),
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
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

  const proc = Bun.spawn(
    // --noprofile --norc: skip /etc/profile and ~/.bashrc to prevent profile-based code execution
    // set -euo pipefail: exit on error, unset vars, pipefail — fail-safe shell defaults
    ["bash", "--noprofile", "--norc", "-c", `set -euo pipefail\n${command}`],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: SAFE_ENV,
    },
  );

  // Wire abort to SIGTERM + escalate to SIGKILL after grace period
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
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
  const [stdoutResult, stderrResult] = await Promise.all([
    drainStream(proc.stdout, budget),
    drainStream(proc.stderr, budget),
  ]);
  const exitCode = await proc.exited;

  // Cleanup
  effectiveSignal?.removeEventListener("abort", onAbort);
  clearTimeout(timer);
  if (killTimer !== undefined) clearTimeout(killTimer);

  const truncated = stdoutResult.truncated || stderrResult.truncated;
  const totalBytes = stdoutResult.byteCount + stderrResult.byteCount;

  const result: BashSuccessResult = {
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
  return result;
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
