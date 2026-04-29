/**
 * Subprocess-based SandboxExecutor implementation.
 *
 * Spawns a child Bun process running subprocess-runner.ts (dev) or
 * subprocess-runner.js (after build) to execute arbitrary code in isolation.
 *
 * Protocol:
 *   argv[2] = absolute path to code file (temp or entry from context)
 *   argv[3] = JSON-encoded input
 *   stderr  = __KOI_RESULT__\n<json>\n  (framed protocol output)
 *
 * Network isolation note:
 *   This executor CANNOT enforce network isolation by itself — it only sets the
 *   KOI_NETWORK_ALLOWED=0 env var as a signal. Real enforcement (namespaces,
 *   firewall rules, seccomp) requires composition with @koi/sandbox-os.
 *
 * Resource limits note:
 *   KOI_MAX_MEMORY_MB and KOI_MAX_PIDS are informational env vars. Real OS-level
 *   enforcement requires composition with @koi/sandbox-os.
 *
 * Process-group kill note:
 *   When `setsid` is available (Linux/macOS), the child is spawned as a new
 *   session leader so that killing -proc.pid (negative) sends SIGKILL to the
 *   entire process group, including grandchildren. On environments where setsid
 *   is not on PATH (Windows, minimal containers), descendant cleanup is
 *   best-effort: only the direct Bun child is killed.
 *   TODO: explore Bun.spawn's posix_spawn flags as an alternative when available.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutionContext,
  SandboxError,
  SandboxErrorCode,
  SandboxExecutor,
  SandboxResult,
} from "@koi/core/sandbox-executor";

/** Framing marker emitted by subprocess-runner on stderr. */
const RESULT_MARKER = "__KOI_RESULT__\n";

/**
 * Allowlist of host env vars that are safe to pass into the sandbox child.
 * All other host env vars (credentials, tokens, etc.) are scrubbed.
 */
const SAFE_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "NODE_ENV",
  "BUN_INSTALL",
  "LANG",
  "LC_ALL",
];

/** Default maximum output bytes read from stderr (10 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Default bun executable name. */
const DEFAULT_BUN_PATH = "bun";

export interface SubprocessExecutorConfig {
  readonly bunPath?: string;
  readonly maxOutputBytes?: number;
  readonly cwd?: string;
}

/** Resolve the runner script path relative to this file's location. */
function resolveRunnerPath(): string {
  const here = import.meta.dir;
  const ext = here.endsWith("dist") ? "subprocess-runner.js" : "subprocess-runner.ts";
  return join(here, ext);
}

/** Write code to a temp file and return its path and the temp dir. */
function writeCodeToTemp(code: string): { readonly codePath: string; readonly tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "koi-sandbox-"));
  const codePath = join(tempDir, "code.ts");
  writeFileSync(codePath, code, "utf8");
  return { codePath, tempDir };
}

/** Clean up temp dir, ignoring errors. */
function cleanupTemp(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_: unknown) {
    // best-effort cleanup — ignore errors
  }
}

/** Parse the framed result from stderr text. Returns undefined if marker absent. */
function parseFramedResult(stderrText: string): unknown {
  const markerIdx = stderrText.lastIndexOf(RESULT_MARKER);
  if (markerIdx === -1) return undefined;
  const jsonStart = markerIdx + RESULT_MARKER.length;
  const jsonText = stderrText.slice(jsonStart).trimEnd();
  try {
    return JSON.parse(jsonText);
  } catch (_: unknown) {
    return undefined;
  }
}

/**
 * Type-predicate: checks that v is a non-null object with an "ok" field,
 * plus optional "output" and "error" fields — the framed result shape.
 * Avoids `as` casts when narrowing the raw JSON parse result.
 */
function isFramedObject(
  v: unknown,
): v is { readonly ok: unknown; readonly output?: unknown; readonly error?: unknown } {
  return v !== null && typeof v === "object" && "ok" in v;
}

/** Classify a killed process exit into a SandboxErrorCode. */
function classifyKilledCode(timerFired: boolean, exitCode: number): SandboxErrorCode {
  if (timerFired) return "TIMEOUT";
  // exitCode 137 = SIGKILL from outside (e.g. OOM killer), -9 = Bun internal
  if (exitCode === 137 || exitCode === -9) return "OOM";
  return "CRASH";
}

/**
 * Build a sanitized child env:
 * 1. Start with {}.
 * 2. Copy from process.env only the keys in SAFE_ENV_KEYS (skip undefined values).
 * 3. Layer in KOI_* signal vars from context.
 * 4. Merge context.env if present (caller-provided wins).
 */
function buildChildEnv(context?: ExecutionContext): Readonly<Record<string, string>> {
  // `let` justified: env is built incrementally in three layers
  const env: Record<string, string> = {};

  // Layer 1: safe host env vars only
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }

  // Layer 2: KOI signal vars from context
  if (context !== undefined) {
    if (context.networkAllowed === false) {
      // Signal: caller requested no network. Real enforcement needs @koi/sandbox-os.
      env.KOI_NETWORK_ALLOWED = "0";
    }
    if (context.resourceLimits !== undefined) {
      // Informational: real enforcement is OS-level (requires @koi/sandbox-os).
      if (context.resourceLimits.maxMemoryMb !== undefined) {
        env.KOI_MAX_MEMORY_MB = String(context.resourceLimits.maxMemoryMb);
      }
      if (context.resourceLimits.maxPids !== undefined) {
        env.KOI_MAX_PIDS = String(context.resourceLimits.maxPids);
      }
    }
  }

  return env;
}

/**
 * Read from a ReadableStream<Uint8Array> up to maxBytes, then cancel the rest.
 * Returns the decoded text and a truncated flag.
 *
 * This prevents an adversarial child from OOMing the host by producing unbounded
 * output — we stop consuming (and cancel the stream) once the cap is hit.
 * When `onTruncate` is provided, it is called once the moment truncation occurs —
 * callers use it to kill the child process immediately so proc.exited resolves
 * and the Promise.all completes without waiting for the full timeout.
 */
async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onTruncate?: () => void,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  // `let` justified: buf/total/truncated are accumulated across iterations
  let total = 0;
  let truncated = false;
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      onTruncate?.();
      reader.cancel().catch((_: unknown) => {
        // cancel errors are safe to ignore — we've already stopped reading
      });
      break;
    }
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    buf += decoder.decode(chunk, { stream: true });
    total += chunk.byteLength;
    if (chunk.byteLength < value.byteLength) {
      truncated = true;
      onTruncate?.();
      reader.cancel().catch((_: unknown) => {
        // cancel errors are safe to ignore — we've already stopped reading
      });
      break;
    }
  }
  buf += decoder.decode();
  return { text: buf, truncated };
}

// ---------------------------------------------------------------------------
// Process-group kill (Fix 2)
//
// setsid availability is probed once lazily at first spawn.
// `let` justified: lazily populated on first use.
// ---------------------------------------------------------------------------

/** Cached result of setsid availability probe. undefined = not yet checked. */
let _setsidPath: string | null | undefined;

/** Lazily resolve the path to `setsid`, or null if unavailable. */
function resolveSetsid(): string | null {
  if (_setsidPath !== undefined) return _setsidPath;
  try {
    const r = Bun.spawnSync(["which", "setsid"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0 && r.stdout !== null) {
      // Convert Buffer to Uint8Array for TextDecoder compatibility under strict TS6.
      const bytes = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength);
      const path = new TextDecoder().decode(bytes).trim();
      _setsidPath = path.length > 0 ? path : null;
    } else {
      _setsidPath = null;
    }
  } catch (_: unknown) {
    _setsidPath = null;
  }
  return _setsidPath;
}

/**
 * Kill the child process and, when setsid was used, the entire process group.
 * Falls back to direct proc.kill(9) if group-kill fails or setsid was absent.
 */
function killChild(
  proc: { readonly pid?: number; readonly kill: (signal?: number) => void },
  usedSetsid: boolean,
): void {
  if (usedSetsid && proc.pid !== undefined) {
    try {
      // Negative PID = send signal to the whole process group.
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch (_: unknown) {
      // Group kill failed — fall through to direct kill.
    }
  }
  proc.kill(9);
}

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

export function createSubprocessExecutor(config?: SubprocessExecutorConfig): SandboxExecutor {
  const bunPath = config?.bunPath ?? DEFAULT_BUN_PATH;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const cwdOverride = config?.cwd;

  const runnerPath = resolveRunnerPath();

  return {
    execute: async (
      code: string,
      input: unknown,
      timeoutMs: number,
      context?: ExecutionContext,
    ): Promise<ExecuteResult> => {
      // If context.entryPath is set, use it directly without writing a temp file.
      // A temp dir is still created for cleanup symmetry but left empty.
      const hasTempCode = context?.entryPath === undefined;
      const { codePath, tempDir } = hasTempCode
        ? writeCodeToTemp(code)
        : { codePath: context.entryPath, tempDir: mkdtempSync(join(tmpdir(), "koi-sandbox-")) };

      const start = Date.now();

      try {
        // Determine working directory: per-invocation context wins over config-level cwd.
        const cwd = context?.workspacePath ?? cwdOverride;

        // Always build a sanitized child env — never inherit parent's full process.env.
        const childEnv = buildChildEnv(context);

        // Wrap child in setsid when available so we can kill the entire process
        // group (including grandchildren) via process.kill(-pid, "SIGKILL").
        const setsidPath = resolveSetsid();
        const usedSetsid = setsidPath !== null;
        const cmd = usedSetsid
          ? [setsidPath, bunPath, "run", runnerPath, codePath, JSON.stringify(input ?? null)]
          : [bunPath, "run", runnerPath, codePath, JSON.stringify(input ?? null)];

        const spawnOpts = {
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          // Ignore stdin so the sandboxed child cannot read from parent's stdin.
          stdin: "ignore" as const,
          ...(cwd !== undefined ? { cwd } : {}),
          env: childEnv,
        };

        const proc = Bun.spawn(cmd, spawnOpts);

        // Kill the process (group) after timeout.
        // `let` justified: `killed` is a mutable flag set inside the timer callback.
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          killChild(proc, usedSetsid);
        }, timeoutMs);

        // Bun's Timer type does not expose `unref` in its declared types but the
        // underlying object supports it at runtime — check defensively.
        if ("unref" in timer && typeof timer.unref === "function") timer.unref();

        // Kill immediately when output cap is hit — prevents child blocking on full
        // pipes and turning into a false TIMEOUT (Fix 3).
        // `let` justified: killTriggered is a shared one-shot guard across both readers.
        let killTriggered = false;
        const triggerKill = (): void => {
          if (killTriggered) return;
          killTriggered = true;
          killChild(proc, usedSetsid);
        };

        // Drain stdout AND stderr concurrently using bounded readers (Fix 1).
        // A chatty child that fills the stdout pipe buffer will deadlock if we only
        // await proc.exited while leaving stdout unread. Start both drains first.
        // Both streams are capped at maxOutputBytes to prevent host OOM.
        // triggerKill fires the moment either reader hits the cap, so proc.exited
        // resolves promptly and the Promise.all completes without waiting for timeout.
        const [, stderrResult, exitCode] = await Promise.all([
          readBoundedText(proc.stdout, maxOutputBytes, triggerKill),
          readBoundedText(proc.stderr, maxOutputBytes, triggerKill),
          proc.exited,
        ]);
        clearTimeout(timer);

        const durationMs = Date.now() - start;

        // Killed or OOM
        if (killed || exitCode === 137 || exitCode === -9) {
          const errorCode: SandboxErrorCode = classifyKilledCode(killed, exitCode ?? -1);
          const error: SandboxError = {
            code: errorCode,
            message:
              errorCode === "TIMEOUT"
                ? "Sandbox execution timed out"
                : "Sandbox process killed (OOM or signal)",
            durationMs,
          };
          return { ok: false, error };
        }

        // When stderr was truncated, the framing marker may have been cut off.
        // Treat a truncated stderr the same as a missing marker → CRASH.
        if (stderrResult.truncated) {
          const snippet = `${stderrResult.text.slice(-2000)} [truncated]`;
          const error: SandboxError = {
            code: "CRASH",
            message: "Sandbox stderr exceeded output limit; result marker may be missing",
            durationMs,
            stack: snippet,
          };
          return { ok: false, error };
        }

        // Search marker in full text; only apply maxOutputBytes to the snippet
        // used in CRASH error messages (truncating before the search would miss
        // markers that land past the cap and misclassify results as CRASH).
        const framed = parseFramedResult(stderrResult.text);

        if (framed === undefined) {
          const snippet = stderrResult.text.slice(-2000).slice(0, maxOutputBytes);
          const error: SandboxError = {
            code: "CRASH",
            message: "Sandbox exited without result marker",
            durationMs,
            stack: snippet,
          };
          return { ok: false, error };
        }

        if (!isFramedObject(framed)) {
          const error: SandboxError = {
            code: "CRASH",
            message: "Sandbox result marker contained invalid JSON",
            durationMs,
          };
          return { ok: false, error };
        }

        if (framed.ok === false) {
          const errMsg = typeof framed.error === "string" ? framed.error : "Unknown sandbox error";
          const error: SandboxError = {
            code: "CRASH",
            message: errMsg,
            durationMs,
          };
          return { ok: false, error };
        }

        const value: SandboxResult = {
          output: framed.output,
          durationMs,
        };
        return { ok: true, value };
      } finally {
        // Always remove temp dir, even if spawn or stderr read throws.
        cleanupTemp(tempDir);
      }
    },
  };
}
