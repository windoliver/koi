/**
 * createArgvGate — argv-only subprocess verifier.
 *
 * Takes a non-empty argv tuple (never a shell string). Spawns via Bun.spawn,
 * passes the verifier's AbortSignal through so subprocess cleanup is
 * automatic on abort, and returns a typed VerifierResult.
 *
 * Design choices:
 * - Argv only: no shell metacharacters, no quoting rules, no injection surface.
 *   Compose multi-step verifiers with createCompositeGate.
 * - stderr is captured up to a byte cap and surfaced in details on failure.
 * - timeout is advisory — the main loop also applies verifierTimeoutMs at a
 *   higher level, so a gate's own timeout is a tighter inner bound.
 * - env: **secure by default**. When omitted, the subprocess gets a minimal
 *   allowlist drawn from the parent environment (PATH, HOME, USER, LANG,
 *   LC_*, TMPDIR, TERM). Callers can supply an explicit `env` to override,
 *   or pass `inheritEnv: true` to fall back to full parent-env inheritance
 *   for legacy use cases. The secure default matters because the verifier
 *   is by design an arbitrary subprocess running code the agent may have
 *   just modified — full env inheritance would leak every secret in the
 *   caller's environment to that subprocess.
 */

import { LOOP_DEFAULTS, type Verifier, type VerifierResult } from "../types.js";

/**
 * Environment variables always forwarded to the verifier subprocess
 * when the caller does not supply an explicit `env`. Limited to names
 * a typical test runner needs for locale, tooling paths, scratch
 * space, and test-framework mode — no credentials, no app config,
 * no provider keys.
 *
 * NODE_ENV / CI are included because they are load-bearing for test
 * runners: dropping NODE_ENV would cause `bun test` / `pytest` /
 * `vitest` / `jest` to pick up production-mode code paths instead of
 * test-mode behavior, silently masking real failures. They are
 * framework mode signals, not secrets.
 */
const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  // Test-framework mode signals (not secrets)
  "NODE_ENV",
  "CI",
  "DEBUG",
  "FORCE_COLOR",
  "NO_COLOR",
];

function buildDefaultEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export interface ArgvGateOptions {
  readonly cwd?: string;
  /**
   * Explicit environment for the verifier subprocess. When supplied,
   * takes precedence over both the minimal-env default and `inheritEnv`.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Legacy escape hatch: when true, the subprocess inherits the full
   * parent environment (Bun.spawn's default). Secure-by-default is
   * `false` — the minimal allowlist is used unless the caller opts in.
   * Only set this when you understand that the verifier will receive
   * every variable in the calling process, including API keys,
   * database URLs, and other project secrets.
   */
  readonly inheritEnv?: boolean;
  readonly timeoutMs?: number;
  readonly stderrBytes?: number;
}

export function createArgvGate(
  argv: readonly [string, ...string[]],
  options: ArgvGateOptions = {},
): Verifier {
  if (argv.length === 0) {
    throw new Error("createArgvGate: argv must be a non-empty tuple");
  }
  // Defensive runtime check — TS types already enforce the tuple shape.
  for (const token of argv) {
    if (typeof token !== "string") {
      throw new Error("createArgvGate: every argv token must be a string");
    }
  }

  const stderrBytes = options.stderrBytes ?? LOOP_DEFAULTS.argvStderrBytes;

  return {
    async check(ctx): Promise<VerifierResult> {
      const cwd = options.cwd ?? ctx.workingDir;

      // Inner timeout is scoped to this gate; outer loop-level timeout
      // composes via ctx.signal through a separate AbortSignal.any above us.
      const innerController = new AbortController();
      const innerTimer =
        options.timeoutMs !== undefined
          ? setTimeout(() => innerController.abort(), options.timeoutMs)
          : undefined;

      const combinedSignal =
        options.timeoutMs !== undefined
          ? AbortSignal.any([ctx.signal, innerController.signal])
          : ctx.signal;

      // Never echo full argv — tokens and URLs with credentials often land
      // in argv and would leak into telemetry and model prompts. Only the
      // executable name (argv[0]) is safe to surface. Hoisted above the
      // try so the catch-path timeout branch can reach it.
      const safeName = argv[0];

      // Resolve the effective env per the secure-default contract:
      //   1. options.env wins outright when supplied.
      //   2. options.inheritEnv: true → snapshot the full parent env.
      //      (Bun.spawn does NOT auto-inherit when env is omitted;
      //      we must pass process.env explicitly.)
      //   3. Otherwise → minimal allowlist of locale/tooling vars only.
      const effectiveEnv: Record<string, string> =
        options.env !== undefined
          ? { ...options.env }
          : options.inheritEnv === true
            ? Object.fromEntries(
                Object.entries(process.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              )
            : buildDefaultEnv();

      try {
        // Spread the tuple into an argv array; Bun.spawn accepts string[].
        //
        // stdout is piped AND drained concurrently with stderr. If we left it
        // piped but unread, a verbose verifier (e.g. `bun test` printing
        // thousands of lines) can fill the stdout pipe buffer, block the
        // child on write(), and leave `proc.exited` unresolved — manifesting
        // as a spurious timeout or permanent hang. Draining into a capped
        // buffer costs nothing on small outputs and is mandatory for correctness.
        const proc = Bun.spawn([...argv], {
          cwd,
          env: effectiveEnv,
          stdout: "pipe",
          stderr: "pipe",
          signal: combinedSignal,
        });

        const [exitCode, stderrText, stdoutText] = await Promise.all([
          proc.exited,
          readCapped(proc.stderr, stderrBytes),
          readCapped(proc.stdout, stderrBytes),
        ]);

        if (ctx.signal.aborted) {
          return {
            ok: false,
            reason: "aborted",
            details: "argv gate aborted by external signal",
          };
        }

        if (innerController.signal.aborted) {
          return {
            ok: false,
            reason: "timeout",
            details: `argv gate exceeded ${options.timeoutMs}ms: ${safeName}`,
          };
        }

        if (exitCode === 0) {
          return { ok: true };
        }

        // Prefer stderr for failure details, fall back to stdout (some tools
        // like `bun test` write failures to stdout), then to a synthetic
        // exit-code line if both streams are empty.
        const details =
          stderrText.length > 0
            ? stderrText
            : stdoutText.length > 0
              ? stdoutText
              : `${safeName} exited with code ${exitCode}`;
        return {
          ok: false,
          reason: "exit_nonzero",
          details,
          exitCode,
        };
      } catch (err) {
        if (ctx.signal.aborted) {
          return {
            ok: false,
            reason: "aborted",
            details: "argv gate aborted by external signal",
          };
        }
        if (innerController.signal.aborted) {
          return {
            ok: false,
            reason: "timeout",
            details: `argv gate exceeded ${options.timeoutMs}ms: ${safeName}`,
          };
        }
        return {
          ok: false,
          reason: "spawn_error",
          details: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (innerTimer !== undefined) clearTimeout(innerTimer);
      }
    },
  };
}

/**
 * Read a ReadableStream<Uint8Array> into a UTF-8 string, capped at maxBytes.
 * Drains and discards the rest so the subprocess does not stall on a full pipe.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | undefined,
  maxBytes: number,
): Promise<string> {
  if (stream === undefined) return "";
  const reader = stream.getReader();
  const collected: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (total < maxBytes) {
        const room = maxBytes - total;
        if (value.byteLength <= room) {
          collected.push(value);
          total += value.byteLength;
        } else {
          collected.push(value.subarray(0, room));
          total = maxBytes;
        }
      }
      // Keep reading after cap is hit to drain the pipe, but drop the bytes.
    }
  } finally {
    reader.releaseLock();
  }
  if (collected.length === 0) return "";
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of collected) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}
