/**
 * Nexus CLI lifecycle management — delegates to `nexus init/up/down`.
 *
 * Replaces manual process spawning + PID tracking with Nexus's own
 * Docker Compose-based lifecycle (nexi-lab/nexus#2918).
 *
 * - `nexusInit()` scaffolds `nexus.yaml` via `nexus init --preset <preset>`
 * - `nexusUp()` starts the Nexus stack via `nexus up` (blocks until healthy)
 * - `nexusDown()` stops the stack via `nexus down`
 */

import { existsSync } from "node:fs";
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
  /** Base URL of the running Nexus API. */
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
 * Starts the Nexus stack via `nexus up`.
 *
 * If `nexus.yaml` doesn't exist in the working directory, auto-runs
 * `nexus init --preset <koiPreset>` first.
 *
 * Blocks until all Nexus services are healthy (health polling is handled
 * by the Nexus CLI itself).
 */
export async function nexusUp(
  options?: NexusLifecycleOptions & {
    /** Koi preset for auto-init when nexus.yaml is missing. Default: "local". */
    readonly koiPreset?: string | undefined;
    /** Port override. Default: 2026. */
    readonly port?: number | undefined;
    /** Host override. Default: "127.0.0.1". */
    readonly host?: string | undefined;
  },
): Promise<Result<NexusUpResult, KoiError>> {
  const cwd = options?.cwd ?? process.cwd();
  const verbose = options?.verbose ?? false;
  const port = options?.port ?? DEFAULT_PORT;
  const host = options?.host ?? DEFAULT_HOST;

  const binaryCheck = await ensureBinary();
  if (!binaryCheck.ok) return binaryCheck;

  // Auto-init if nexus.yaml doesn't exist
  let autoInitialized = false;
  const configPath = join(cwd, "nexus.yaml");
  if (!existsSync(configPath)) {
    const koiPreset = options?.koiPreset ?? "local";
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
 * Runs a nexus CLI subcommand and waits for it to exit.
 * Returns error result on non-zero exit code.
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
      stdout: verbose ? "inherit" : "ignore",
      stderr: verbose ? "inherit" : "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      let stderrText = "";
      if (!verbose && proc.stderr !== null) {
        stderrText = await new Response(proc.stderr).text();
      }
      return {
        ok: false,
        error: {
          code: "EXTERNAL" as const,
          message: `${label} exited with code ${String(exitCode)}${stderrText ? `: ${stderrText.trim()}` : ""}`,
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
