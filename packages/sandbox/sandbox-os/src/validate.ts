import type { KoiError, Result, SandboxProfile } from "@koi/core";

import type { SandboxPlatform } from "./detect.js";

const PATH_FIELDS = ["allowRead", "denyRead", "allowWrite", "denyWrite"] as const;

function validationError(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
    },
  };
}

function isAbsoluteSandboxPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/");
}

export function validateProfile(
  profile: SandboxProfile,
  platform: SandboxPlatform,
): Result<SandboxProfile, KoiError> {
  for (const field of PATH_FIELDS) {
    const paths = profile.filesystem[field];
    if (paths === undefined) {
      continue;
    }

    for (const path of paths) {
      if (!isAbsoluteSandboxPath(path)) {
        return validationError(`Sandbox ${field} path must be absolute or ~/ prefixed: ${path}`);
      }
    }
  }

  if (profile.filesystem.defaultReadAccess === "closed" && platform === "seatbelt") {
    return validationError(
      "macOS seatbelt requires defaultReadAccess 'open' because dyld and system frameworks need broad read access.",
    );
  }

  if (
    profile.filesystem.defaultReadAccess === "closed" &&
    platform === "bwrap" &&
    (profile.resources.maxPids !== undefined || profile.resources.maxOpenFiles !== undefined)
  ) {
    return validationError(
      "Resource limits (maxPids/maxOpenFiles) require a sh -c wrapper, but /bin/sh is not " +
        "available in closed-mode bwrap sandboxes. Mount /bin/sh in allowRead or use open mode.",
    );
  }

  return { ok: true, value: profile };
}
