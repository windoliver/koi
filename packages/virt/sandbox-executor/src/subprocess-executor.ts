/**
 * Subprocess-based promoted executor — runs brick code in an isolated child process.
 *
 * Instead of executing via in-process `import()`, spawns a child Bun process
 * that loads the brick's entry module. This provides process-level isolation:
 * - Separate memory space (no access to host heap)
 * - Killable on timeout (SIGKILL, not just Promise.race)
 * - Restricted environment variables (only what's explicitly passed)
 * - Crash isolation (child OOM/segfault doesn't take down host)
 * - Network isolation via Seatbelt (macOS) / Bubblewrap (Linux)
 * - Resource limits via ulimit (memory, PIDs)
 *
 * Falls back to in-process `new Function()` for bricks without entry files
 * (backward-compatible with existing behavior).
 */

import { join } from "node:path";
import type { ExecutionContext, SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

interface SubprocessOutput {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
}

export type SandboxPlatform = "seatbelt" | "bwrap" | "none";

export interface IsolatedCommand {
  readonly cmd: readonly string[];
  readonly platform: SandboxPlatform;
  /** True when network isolation was requested but the platform lacks a sandbox. */
  readonly degraded?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path to the subprocess runner script.
 * When running from source, import.meta.dir is `src/` and the runner is adjacent.
 * When imported from built output (dist/), fall back to the `src/` sibling directory.
 */
function resolveRunnerPath(): string {
  const adjacent = join(import.meta.dir, "subprocess-runner.ts");
  if (import.meta.dir.endsWith("/dist") || import.meta.dir.endsWith("\\dist")) {
    // Built output — resolve to src/ sibling
    return join(import.meta.dir, "..", "src", "subprocess-runner.ts");
  }
  return adjacent;
}

const RUNNER_PATH = resolveRunnerPath();

/** Maximum stdout size from subprocess (10 MB). Prevents OOM from malicious output. */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

/** Environment variables safe to forward to child processes. */
const SAFE_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "NODE_ENV", "BUN_INSTALL"]);

/**
 * Generate a Seatbelt SBPL profile that denies network access.
 * File writes are restricted to the workspace and /tmp only.
 * Allows process-exec, process-fork, file-read, mach-lookup,
 * sysctl-read, and self-targeted signals (required for Bun to function).
 *
 * @param workspacePath - Optional workspace path to allow writes to.
 *   When undefined, only /tmp writes are permitted.
 */
function generateSeatbeltProfile(workspacePath?: string): string {
  const writeRules =
    workspacePath !== undefined
      ? [
          `(allow file-write* (subpath "${workspacePath}"))`,
          '(allow file-write* (subpath "/tmp"))',
          '(allow file-write* (subpath "/private/tmp"))',
        ]
      : ['(allow file-write* (subpath "/tmp"))', '(allow file-write* (subpath "/private/tmp"))'];

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow file-read*)",
    ...writeRules,
    "(allow mach-lookup)",
    "(allow sysctl-read)",
    "(allow signal (target self))",
    "(deny network*)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Cache for platform detection — only runs once per process. */
// let justified: mutable cache for one-time platform detection result
let cachedPlatform: SandboxPlatform | undefined;

export function detectSandboxPlatform(): SandboxPlatform {
  if (cachedPlatform !== undefined) {
    return cachedPlatform;
  }

  if (process.platform === "darwin") {
    cachedPlatform = "seatbelt";
    return cachedPlatform;
  }

  if (process.platform === "linux") {
    try {
      const result = Bun.spawnSync(["which", "bwrap"], { stdout: "pipe", stderr: "pipe" });
      cachedPlatform = result.exitCode === 0 ? "bwrap" : "none";
    } catch (_: unknown) {
      cachedPlatform = "none";
    }
    return cachedPlatform;
  }

  cachedPlatform = "none";
  return cachedPlatform;
}

// ---------------------------------------------------------------------------
// Shell escaping
// ---------------------------------------------------------------------------

/** Single-quote wrapping for shell arguments. Handles embedded single quotes. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Isolation command builder
// ---------------------------------------------------------------------------

/**
 * Build an OS-isolated command wrapping the base command with network isolation
 * and/or resource limits when requested.
 *
 * | Platform | networkAllowed=false | resourceLimits set |
 * |----------|---------------------|--------------------|
 * | macOS    | sandbox-exec -p ... | ulimit -v prefix   |
 * | Linux    | bwrap --unshare-net | ulimit -v/-u       |
 * | Other    | warn + passthrough  | ulimit wrapper     |
 * | Neither  | passthrough         | passthrough         |
 */
export function buildIsolatedCommand(
  baseCmd: readonly string[],
  context?: ExecutionContext,
): IsolatedCommand {
  const needsNetworkDeny = context?.networkAllowed === false;
  const limits = context?.resourceLimits;
  const needsLimits =
    limits !== undefined && (limits.maxMemoryMb !== undefined || limits.maxPids !== undefined);

  // No isolation needed — passthrough
  if (!needsNetworkDeny && !needsLimits) {
    return { cmd: baseCmd, platform: "none" };
  }

  const platform = detectSandboxPlatform();
  const escapedBaseCmd = baseCmd.map(shellEscape).join(" ");

  // Build ulimit prefix for resource limits
  const ulimitParts: string[] = [];
  if (limits?.maxMemoryMb !== undefined) {
    // ulimit -v uses KB
    const kb = limits.maxMemoryMb * 1024;
    ulimitParts.push(`ulimit -v ${String(kb)}`);
  }
  if (limits?.maxPids !== undefined && platform === "bwrap") {
    // ulimit -u only meaningful on Linux (macOS ignores it)
    ulimitParts.push(`ulimit -u ${String(limits.maxPids)}`);
  }

  const ulimitPrefix = ulimitParts.length > 0 ? `${ulimitParts.join(" && ")} && ` : "";
  const innerCmd = `${ulimitPrefix}exec ${escapedBaseCmd}`;

  if (platform === "seatbelt" && needsNetworkDeny) {
    const profile = generateSeatbeltProfile(context?.workspacePath);
    return {
      cmd: ["sandbox-exec", "-p", profile, "sh", "-c", innerCmd],
      platform: "seatbelt",
    };
  }

  if (platform === "bwrap" && needsNetworkDeny) {
    // Mount root read-only, then bind workspace read-write + isolated /tmp
    const workspaceBinds =
      context?.workspacePath !== undefined
        ? ["--bind", context.workspacePath, context.workspacePath]
        : [];
    return {
      cmd: [
        "bwrap",
        "--unshare-net",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        ...workspaceBinds,
        "--tmpfs",
        "/tmp",
        "sh",
        "-c",
        innerCmd,
      ],
      platform: "bwrap",
    };
  }

  // Only resource limits requested (no network deny), or platform lacks sandbox
  if (needsLimits) {
    return {
      cmd: ["sh", "-c", innerCmd],
      platform: "none",
    };
  }

  // Network deny requested but no sandbox available — fail closed.
  // Caller receives platform="none" with degraded=true to make informed decision.
  return { cmd: [...baseCmd], platform: "none", degraded: needsNetworkDeny };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSafeEnv(workspacePath?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Add workspace's node_modules to NODE_PATH so imports resolve
  if (workspacePath !== undefined) {
    env.NODE_PATH = join(workspacePath, "node_modules");
  }
  return env;
}

function classifyError(e: unknown, durationMs: number): SandboxError {
  const message = e instanceof Error ? e.message : String(e);

  if (message.includes("timed out") || message.includes("SIGKILL")) {
    return { code: "TIMEOUT", message, durationMs };
  }
  if (message.includes("Permission denied") || message.includes("EACCES")) {
    return { code: "PERMISSION", message, durationMs };
  }
  if (message.includes("out of memory") || message.includes("OOM")) {
    return { code: "OOM", message, durationMs };
  }

  return { code: "CRASH", message, durationMs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CompiledFn = (input: unknown) => unknown;

export function createSubprocessExecutor(): SandboxExecutor {
  const execute = async (
    code: string,
    input: unknown,
    timeoutMs: number,
    context?: ExecutionContext,
  ): Promise<ExecuteResult> => {
    const start = performance.now();

    // Subprocess path: when entryPath is available, run in child process
    if (context?.entryPath !== undefined) {
      try {
        const payload = JSON.stringify({ entryPath: context.entryPath, input });
        const env = buildSafeEnv(context.workspacePath);

        const isolated = buildIsolatedCommand(["bun", "run", RUNNER_PATH], context);

        // Fail closed: if network isolation was requested but no sandbox is available,
        // refuse to execute rather than silently running without isolation.
        if (isolated.degraded === true) {
          const durationMs = performance.now() - start;
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message:
                "Network isolation requested but no OS sandbox available (install bubblewrap on Linux or use macOS)",
              durationMs,
            },
          };
        }

        const proc = Bun.spawn([...isolated.cmd], {
          stdin: new Blob([payload]),
          stdout: "pipe",
          stderr: "pipe",
          env,
          ...(context.workspacePath !== undefined ? { cwd: context.workspacePath } : {}),
        });

        const timeoutId = setTimeout(() => {
          proc.kill("SIGKILL");
        }, timeoutMs);

        const exitCode = await proc.exited;
        clearTimeout(timeoutId);

        const stdout = await new Response(proc.stdout).text();
        const durationMs = performance.now() - start;

        if (stdout.length > MAX_STDOUT_BYTES) {
          return {
            ok: false,
            error: {
              code: "CRASH",
              message: `Subprocess output exceeded ${String(MAX_STDOUT_BYTES)} byte limit`,
              durationMs,
            },
          };
        }

        if (exitCode !== 0) {
          // Try to parse structured error from stdout
          try {
            const parsed = JSON.parse(stdout) as SubprocessOutput;
            if (parsed.error !== undefined) {
              return { ok: false, error: classifyError(new Error(parsed.error), durationMs) };
            }
          } catch (_: unknown) {
            // Fallback to stderr
          }

          const stderr = await new Response(proc.stderr).text();
          const errorMsg =
            stderr.length > 0 ? stderr : `Subprocess exited with code ${String(exitCode)}`;
          return { ok: false, error: classifyError(new Error(errorMsg), durationMs) };
        }

        // Parse structured output
        // let justified: result is parsed from stdout JSON
        let result: SubprocessOutput;
        try {
          result = JSON.parse(stdout) as SubprocessOutput;
        } catch (_: unknown) {
          return {
            ok: false,
            error: { code: "CRASH", message: "Failed to parse subprocess output", durationMs },
          };
        }

        if (!result.ok) {
          return {
            ok: false,
            error: classifyError(new Error(result.error ?? "Unknown subprocess error"), durationMs),
          };
        }

        return { ok: true, value: { output: result.output, durationMs } };
      } catch (e: unknown) {
        const durationMs = performance.now() - start;
        return { ok: false, error: classifyError(e, durationMs) };
      }
    }

    // Fallback: new Function() for bricks without entry files
    try {
      const fn = new Function("input", code) as CompiledFn;
      const result: unknown = await Promise.resolve(fn(input));
      const durationMs = performance.now() - start;
      return { ok: true, value: { output: result, durationMs } };
    } catch (e: unknown) {
      const durationMs = performance.now() - start;
      return { ok: false, error: classifyError(e, durationMs) };
    }
  };

  return { execute };
}
