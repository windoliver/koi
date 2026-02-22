/**
 * spawn() — Streaming sandbox process API.
 * Spawns a sandboxed process with direct stream access.
 */

import type { KoiError, Result } from "@koi/core";
import { detectPlatform } from "./detect.js";
import { buildBwrapArgs } from "./platform/bwrap.js";
import { buildSeatbeltArgs } from "./platform/seatbelt.js";
import type { SandboxProfile } from "./types.js";

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SandboxProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: { write(data: string | Uint8Array): number | Promise<number>; end(): void };
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
}

export function spawn(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
): Result<SandboxProcess, KoiError> {
  const platform = detectPlatform();
  if (!platform.ok) {
    return platform;
  }

  const sandboxArgs =
    platform.value === "seatbelt"
      ? buildSeatbeltArgs(profile, command, args)
      : buildBwrapArgs(profile, command, args);

  const [executable, ...execArgs] = sandboxArgs;
  if (executable === undefined) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "Failed to build sandbox command: empty argument list",
        retryable: false,
      },
    };
  }

  try {
    const spawnOpts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin: "pipe";
      stdout: "pipe";
      stderr: "pipe";
    } = {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    };
    if (options?.cwd !== undefined) {
      spawnOpts.cwd = options.cwd;
    }
    if (options?.env !== undefined) {
      spawnOpts.env = options.env as Record<string, string | undefined>;
    }

    const proc = Bun.spawn([executable, ...execArgs], spawnOpts);

    return {
      ok: true,
      value: {
        pid: proc.pid,
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        stderr: proc.stderr as ReadableStream<Uint8Array>,
        stdin: proc.stdin,
        exited: proc.exited,
        kill: (signal?: number) => proc.kill(signal),
      },
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to spawn sandboxed process: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
        retryable: false,
      },
    };
  }
}
