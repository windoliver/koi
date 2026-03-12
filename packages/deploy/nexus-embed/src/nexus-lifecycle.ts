/**
 * Nexus CLI lifecycle management — delegates to `nexus init/up/down`.
 *
 * Replaces manual process spawning + PID tracking with Nexus's own
 * Docker Compose-based lifecycle (nexi-lab/nexus#2918).
 *
 * Only for Docker-backed presets (demo, shared). The `local` preset
 * exits immediately from `nexus up` without starting services — use
 * the legacy `ensureNexusRunning()` path for local/embed-lite mode.
 *
 * - `nexusInit()` scaffolds `nexus.yaml` via `nexus init --preset <preset>`
 * - `nexusUp()` starts the Nexus stack via `nexus up` (blocks until healthy)
 * - `nexusDown()` stops the stack via `nexus down`
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { checkBinaryAvailable, resolveNexusBinary } from "./binary-resolver.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options shared by all lifecycle commands. */
export interface NexusLifecycleOptions {
  /** Working directory where nexus.yaml lives. Default: process.cwd(). */
  readonly cwd?: string | undefined;
  /** Emit verbose diagnostics to stderr. Default: false. */
  readonly verbose?: boolean | undefined;
}

/** Result of a successful `nexus up`. */
export interface NexusUpResult {
  /** Base URL of the running Nexus API (read from nexus.yaml after startup). */
  readonly baseUrl: string;
  /** Whether `nexus init` was auto-run because nexus.yaml was missing. */
  readonly autoInitialized: boolean;
}

/** Koi preset → Nexus preset mapping. */
const PRESET_MAP: Readonly<Record<string, string>> = {
  local: "local",
  demo: "demo",
  mesh: "shared",
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scaffolds `nexus.yaml` by running `nexus init --preset <preset>`.
 *
 * Maps Koi preset IDs to Nexus preset IDs:
 * - local → local, demo → demo, mesh → shared
 */
export async function nexusInit(
  koiPreset: string,
  options?: NexusLifecycleOptions | undefined,
): Promise<Result<void, KoiError>> {
  const cwd = options?.cwd ?? process.cwd();
  const verbose = options?.verbose ?? false;

  const binaryCheck = await ensureBinary();
  if (!binaryCheck.ok) return binaryCheck;

  const nexusPreset = PRESET_MAP[koiPreset] ?? "local";
  const args = ["init", "--preset", nexusPreset];

  return runNexusCommand(args, cwd, verbose, "nexus init");
}

/**
 * Starts the Nexus Docker Compose stack via `nexus up`.
 *
 * **Important**: Only call this for Docker-backed presets (demo, mesh/shared).
 * The `local` preset's `nexus up` exits with code 0 without starting services.
 * For local/embed-lite mode, use `ensureNexusRunning()` instead.
 *
 * If `nexus.yaml` doesn't exist in the working directory, auto-runs
 * `nexus init --preset <koiPreset>` first.
 *
 * After startup, reads `nexus.yaml` to extract the actual HTTP port
 * (which may differ from the default if ports were auto-shifted during
 * conflict resolution).
 */
export async function nexusUp(
  options?: NexusLifecycleOptions & {
    /** Koi preset for auto-init when nexus.yaml is missing. Default: "demo". */
    readonly koiPreset?: string | undefined;
    /** Host override. Default: "127.0.0.1". */
    readonly host?: string | undefined;
  },
): Promise<Result<NexusUpResult, KoiError>> {
  const cwd = options?.cwd ?? process.cwd();
  const verbose = options?.verbose ?? false;
  const host = options?.host ?? DEFAULT_HOST;

  const binaryCheck = await ensureBinary();
  if (!binaryCheck.ok) return binaryCheck;

  // Auto-init if nexus.yaml doesn't exist
  let autoInitialized = false;
  const configPath = join(cwd, "nexus.yaml");
  if (!existsSync(configPath)) {
    const koiPreset = options?.koiPreset ?? "demo";
    if (verbose) {
      process.stderr.write(
        `Nexus: nexus.yaml not found, running nexus init --preset ${koiPreset}\n`,
      );
    }
    const initResult = await nexusInit(koiPreset, { cwd, verbose });
    if (!initResult.ok) return initResult;
    autoInitialized = true;
  }

  // Run nexus up (blocks until healthy)
  const upResult = await runNexusCommand(["up"], cwd, verbose, "nexus up");
  if (!upResult.ok) return upResult;

  // Read actual port from nexus.yaml (may have been shifted during conflict resolution)
  const port = readNexusHttpPort(configPath);
  const baseUrl = `http://${host}:${String(port)}`;

  return { ok: true, value: { baseUrl, autoInitialized } };
}

/**
 * Stops the Nexus stack via `nexus down`.
 */
export async function nexusDown(
  options?: NexusLifecycleOptions | undefined,
): Promise<Result<void, KoiError>> {
  const cwd = options?.cwd ?? process.cwd();
  const verbose = options?.verbose ?? false;

  const binaryCheck = await ensureBinary();
  if (!binaryCheck.ok) return binaryCheck;

  return runNexusCommand(["down"], cwd, verbose, "nexus down");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Checks that the nexus binary is available on PATH. */
async function ensureBinary(): Promise<Result<void, KoiError>> {
  const binaryParts = resolveNexusBinary();
  const available = await checkBinaryAvailable(binaryParts);
  if (!available) {
    const binaryName = binaryParts[0] ?? "nexus";
    return {
      ok: false,
      error: {
        code: "NOT_FOUND" as const,
        message: `Cannot find '${binaryName}' on PATH. Install it:\n  - uv: pip install nexus-ai-fs\n  - Or set NEXUS_COMMAND`,
        retryable: false,
        context: { binary: binaryName },
      },
    };
  }
  return { ok: true, value: undefined };
}

/**
 * Reads the HTTP port from nexus.yaml (`ports.http`).
 * Falls back to DEFAULT_PORT if the file is missing or unparseable.
 */
function readNexusHttpPort(configPath: string): number {
  try {
    const raw = readFileSync(configPath, "utf-8");
    // Simple YAML extraction — avoid pulling in a YAML parser dependency.
    // nexus.yaml is materialized with explicit keys, so this regex is safe.
    const portsSection = /^ports:\s*\n((?:\s+\S.*\n)*)/m.exec(raw);
    if (portsSection !== undefined && portsSection !== null) {
      const httpMatch = /^\s+http:\s*(\d+)/m.exec(portsSection[1] ?? "");
      if (httpMatch?.[1] !== undefined) {
        const port = Number.parseInt(httpMatch[1], 10);
        if (!Number.isNaN(port) && port > 0) return port;
      }
    }
  } catch {
    // File missing or unreadable — use default
  }
  return DEFAULT_PORT;
}

/**
 * Runs a nexus CLI subcommand and waits for it to exit.
 *
 * Always captures both stdout and stderr so that Nexus CLI errors
 * (emitted via Rich Console to stdout) are surfaced in error messages.
 * In verbose mode, output is also forwarded to inherit streams.
 */
async function runNexusCommand(
  args: readonly string[],
  cwd: string,
  verbose: boolean,
  label: string,
): Promise<Result<void, KoiError>> {
  const binaryParts = resolveNexusBinary();
  const cmd = [...binaryParts, ...args];

  if (verbose) {
    process.stderr.write(`Nexus: running ${cmd.join(" ")}\n`);
  }

  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "ignore",
      // Always pipe to capture output; forward to user in verbose mode after
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    // Collect output (Nexus CLI uses Rich Console on stdout for most messages)
    const stdoutText = proc.stdout !== null ? await new Response(proc.stdout).text() : "";
    const stderrText = proc.stderr !== null ? await new Response(proc.stderr).text() : "";

    // Forward output in verbose mode
    if (verbose) {
      if (stdoutText) process.stdout.write(stdoutText);
      if (stderrText) process.stderr.write(stderrText);
    }

    if (exitCode !== 0) {
      // Combine stdout + stderr for the error message since Nexus
      // prints most diagnostics to stdout via Rich Console
      const output = [stdoutText.trim(), stderrText.trim()].filter((s) => s.length > 0).join("\n");
      return {
        ok: false,
        error: {
          code: "EXTERNAL" as const,
          message: `${label} exited with code ${String(exitCode)}${output ? `:\n${output}` : ""}`,
          retryable: false,
          context: { cmd, exitCode },
        },
      };
    }

    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL" as const,
        message: `Failed to run ${label}: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
        cause: err,
        context: { cmd },
      },
    };
  }
}
