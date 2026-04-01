/**
 * createSandboxCommand() — shared sandbox command construction.
 *
 * Extracts the duplicated platform-detection + args-building logic
 * from execute.ts and spawn.ts into a single reusable function.
 */

import type { KoiError, Result } from "@koi/core";
import { detectPlatform } from "./detect.js";
import { buildBwrapArgs } from "./platform/bwrap.js";
import { buildSeatbeltArgs } from "./platform/seatbelt.js";
import type { SandboxProfile } from "./types.js";

export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * Create the platform-appropriate sandbox command for a given profile.
 *
 * Detects the current platform (macOS → seatbelt, Linux → bwrap),
 * constructs the full argument list, and validates the result.
 */
export function createSandboxCommand(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
): Result<SandboxCommand, KoiError> {
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

  return {
    ok: true,
    value: { executable, args: execArgs },
  };
}
