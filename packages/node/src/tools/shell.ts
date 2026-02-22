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

import type { Tool, ToolDescriptor } from "@koi/core";

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

/** Build a scrubbed environment with only safe keys from process.env. */
function createSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      safe[key] = val;
    }
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShellTool(): Tool {
  return {
    descriptor: DESCRIPTOR,
    trustTier: "sandbox",

    async execute(args) {
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

        // Race between process completion and timeout
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
        });

        const result = await Promise.race([proc.exited, timeoutPromise]);
        // Clear timer to prevent leak when process completes before timeout
        if (timeoutId !== undefined) clearTimeout(timeoutId);

        if (result === "timeout") {
          proc.kill();
          return { error: `Command timed out after ${timeoutMs}ms`, timedOut: true };
        }

        let stdout = await new Response(proc.stdout).text();
        let stderr = await new Response(proc.stderr).text();

        // Truncate oversized output
        const truncated = stdout.length > MAX_OUTPUT_BYTES || stderr.length > MAX_OUTPUT_BYTES;
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = `${stdout.slice(0, MAX_OUTPUT_BYTES)}... [truncated]`;
        }
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = `${stderr.slice(0, MAX_OUTPUT_BYTES)}... [truncated]`;
        }

        return {
          stdout,
          stderr,
          exitCode: result,
          truncated,
        };
      } catch {
        return { error: "Command execution failed" };
      }
    },
  };
}
