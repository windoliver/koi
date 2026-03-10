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
 * When no entry file is available, writes code to a temp file and still
 * executes via subprocess for consistent process-level isolation.
 */

import { tmpdir } from "node:os";
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

/** Maximum output size from subprocess (10 MB). Prevents OOM from malicious output. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Framing marker for protocol JSON in stderr — must match subprocess-runner.ts. */
const RESULT_MARKER = "__KOI_RESULT__";

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
// Protocol extraction
// ---------------------------------------------------------------------------

/**
 * Extract protocol JSON from stderr output using the framing marker.
 * Returns null if no marker is found.
 */
function extractProtocolJson(stderr: string): string | null {
  const idx = stderr.lastIndexOf(RESULT_MARKER);
  if (idx === -1) return null;

  const start = idx + RESULT_MARKER.length;
  const end = stderr.indexOf("\n", start);
  return end === -1 ? stderr.slice(start) : stderr.slice(start, end);
}

// ---------------------------------------------------------------------------
// Streaming output collection with byte limit
// ---------------------------------------------------------------------------

/**
 * Collect a ReadableStream into a string, stopping at `maxBytes`.
 * Calls `onExceeded` (e.g., to kill the process) if the limit is hit
 * so we don't keep buffering data we'll discard.
 */
async function collectWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: () => void,
): Promise<{ readonly text: string; readonly exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // Justified `let`: accumulated byte count
  let totalBytes = 0;
  // Justified `let`: flag set when limit exceeded
  let exceeded = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        exceeded = true;
        onExceeded();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (exceeded) {
    return { text: "", exceeded: true };
  }

  const merged = new Uint8Array(totalBytes);
  // Justified `let`: write offset into merged buffer
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(merged), exceeded: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

        // Stream both stdout and stderr with size caps to prevent OOM.
        // Protocol output is framed in stderr (via __KOI_RESULT__ marker).
        // stdout is free for brick user code and is discarded.
        // Start drains BEFORE awaiting exit to prevent pipe-buffer deadlock.
        const [stdoutResult, stderrResult] = await Promise.all([
          collectWithLimit(proc.stdout, MAX_OUTPUT_BYTES, () => proc.kill("SIGKILL")),
          collectWithLimit(proc.stderr, MAX_OUTPUT_BYTES, () => proc.kill("SIGKILL")),
        ]);

        const exitCode = await proc.exited;
        clearTimeout(timeoutId);
        const durationMs = performance.now() - start;

        if (stdoutResult.exceeded || stderrResult.exceeded) {
          return {
            ok: false,
            error: {
              code: "CRASH",
              message: `Subprocess output exceeded ${String(MAX_OUTPUT_BYTES)} byte limit`,
              durationMs,
            },
          };
        }

        // Extract protocol JSON from stderr using the framing marker.
        // Any stderr output before/after the marker is non-protocol (e.g., warnings).
        const protocolJson = extractProtocolJson(stderrResult.text);

        if (protocolJson === null) {
          if (exitCode !== 0) {
            const errorMsg =
              stderrResult.text.length > 0
                ? stderrResult.text
                : `Subprocess exited with code ${String(exitCode)}`;
            return { ok: false, error: classifyError(new Error(errorMsg), durationMs) };
          }
          return {
            ok: false,
            error: { code: "CRASH", message: "No protocol output from subprocess", durationMs },
          };
        }

        // let justified: result is parsed from protocol JSON
        let result: SubprocessOutput;
        try {
          result = JSON.parse(protocolJson) as SubprocessOutput;
        } catch (_: unknown) {
          return {
            ok: false,
            error: {
              code: "CRASH",
              message: "Failed to parse subprocess protocol output",
              durationMs,
            },
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

    // No entryPath: write code to a temp file and execute in a subprocess.
    // This ensures process-level isolation even for dependency-free bricks.
    try {
      const tempId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const tempEntry = join(tmpdir(), `koi-sandbox-${tempId}.ts`);

      // Wrap raw code body in a default-export function so the subprocess
      // runner can import and invoke it via the standard protocol.
      const wrapped = `export default function run(input: unknown) {\n${code}\n}\n`;
      await Bun.write(tempEntry, wrapped);

      try {
        const tempContext: ExecutionContext = {
          ...context,
          entryPath: tempEntry,
        };
        return await execute(code, input, timeoutMs, tempContext);
      } finally {
        // Best-effort cleanup — don't block on failure
        Bun.file(tempEntry)
          .exists()
          .then((exists) => {
            if (exists) {
              return Bun.write(tempEntry, "").then(() =>
                import("node:fs/promises").then((fs) => fs.unlink(tempEntry)),
              );
            }
          })
          .catch(() => {});
      }
    } catch (e: unknown) {
      const durationMs = performance.now() - start;
      return { ok: false, error: classifyError(e, durationMs) };
    }
  };

  return { execute };
}
