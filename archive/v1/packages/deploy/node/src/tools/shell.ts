/**
 * Built-in shell tool — execute commands with timeout enforcement.
 *
 * Runs commands via Bun.spawn() with configurable timeout.
 * Output is captured and truncated to prevent memory issues.
 *
 * SECURITY: This tool passes commands to `sh -c`. It relies on the
 * middleware-sandbox layer (L2) for OS-level isolation. Defense-in-depth
 * is provided by: env scrubbing, output limits, and timeout enforcement.
 * Full sandboxing is enforced by @koi/middleware-sandbox wrapping tool.execute().
 */

import type { Tool, ToolDescriptor, ToolExecuteOptions } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { getExecutionContext, mapContextToEnv } from "@koi/execution-context";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DESCRIPTOR: ToolDescriptor = {
  name: "shell",
  description: "Execute shell commands with timeout enforcement",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      cwd: {
        type: "string",
        description: "Working directory (defaults to process.cwd())",
      },
      timeoutMs: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["command"],
  },
};

/** Maximum output size to capture (256 KiB). */
const MAX_OUTPUT_BYTES = 262_144;

/** Default command timeout (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Environment variable allowlist — only these keys are passed to child processes.
 * Prevents leaking secrets (API keys, tokens, HMAC secrets) from process.env.
 */
const SAFE_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TZ",
];

/** Build a scrubbed environment with only safe keys from process.env + KOI_* context vars. */
function createSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      safe[key] = val;
    }
  }
  // Merge KOI_* context env vars (if running within an L1 agent loop)
  const ctx = getExecutionContext();
  if (ctx !== undefined) {
    const koiEnv = mapContextToEnv(ctx);
    for (const [k, v] of Object.entries(koiEnv)) {
      safe[k] = v;
    }
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read stdout/stderr from a completed process, truncating oversized output. */
async function readOutput(proc: {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exitCode: number | null;
}): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly truncated: boolean;
}> {
  let stdout = await new Response(proc.stdout).text();
  let stderr = await new Response(proc.stderr).text();

  const truncated = stdout.length > MAX_OUTPUT_BYTES || stderr.length > MAX_OUTPUT_BYTES;
  if (stdout.length > MAX_OUTPUT_BYTES) {
    stdout = `${stdout.slice(0, MAX_OUTPUT_BYTES)}... [truncated]`;
  }
  if (stderr.length > MAX_OUTPUT_BYTES) {
    stderr = `${stderr.slice(0, MAX_OUTPUT_BYTES)}... [truncated]`;
  }

  return { stdout, stderr, exitCode: proc.exitCode, truncated };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShellTool(): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,

    async execute(args, options?: ToolExecuteOptions) {
      const signal = options?.signal;

      // Fast-path: already cancelled before we start
      if (signal?.aborted) {
        return { error: "Command cancelled", cancelled: true };
      }

      const command = args.command;
      if (typeof command !== "string" || command.length === 0) {
        return { error: "Invalid arguments: command must be a non-empty string" };
      }

      const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
      const timeoutMs =
        typeof args.timeoutMs === "number" && args.timeoutMs > 0
          ? args.timeoutMs
          : DEFAULT_TIMEOUT_MS;

      try {
        const proc = Bun.spawn(["sh", "-c", command], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: createSafeEnv(),
        });

        if (signal !== undefined) {
          // Signal-based path: external signal handles cancellation, no internal timeout.
          // This is the preferred path when the caller provides a signal (e.g., from
          // executeWithSignal's AbortSignal.timeout).
          const onAbort = (): void => {
            proc.kill();
          };
          signal.addEventListener("abort", onAbort, { once: true });

          try {
            await proc.exited;

            // Check if signal aborted while waiting. There is a negligible TOCTOU
            // window where the process may have completed normally at the same instant
            // the signal fired — worst case is reporting a completed command as
            // "cancelled," which is acceptable for signal-based cancellation semantics.
            if (signal.aborted) {
              proc.kill();
              return { error: "Command cancelled", cancelled: true };
            }

            return readOutput(proc);
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        } else {
          // Legacy path: internal setTimeout for standalone usage (no signal provided).
          // Provides backward compatibility for callers that don't pass a signal.

          // let justified: cleared in finally block
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<"timeout">((resolve) => {
            timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
          });

          try {
            const result = await Promise.race([proc.exited, timeoutPromise]);
            if (timeoutId !== undefined) clearTimeout(timeoutId);

            if (result === "timeout") {
              proc.kill();
              return { error: `Command timed out after ${timeoutMs}ms`, timedOut: true };
            }

            return readOutput(proc);
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "unknown error";
        return { error: `Command execution failed: ${msg}` };
      }
    },
  };
}
