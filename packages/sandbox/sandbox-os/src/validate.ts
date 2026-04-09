import type { KoiError, Result, SandboxProfile } from "@koi/core";

import type { SandboxPlatform } from "./detect.js";
import { hasGlobPattern } from "./path-utils.js";

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
      // Reject glob patterns in all path fields.
      // bwrap mounts paths literally — globs in denyRead/denyWrite cause spawn errors;
      // globs in allowWrite get silently broadened to the parent directory (security risk).
      if (hasGlobPattern(path)) {
        return validationError(
          `Sandbox ${field} path must not contain glob patterns: '${path}'. ` +
            "Specify exact directories — platform backends cannot enforce file-level filtering.",
        );
      }
    }
  }

  if (profile.filesystem.defaultReadAccess === "closed" && platform === "seatbelt") {
    return validationError(
      "macOS seatbelt requires defaultReadAccess 'open' because dyld and system frameworks need broad read access.",
    );
  }

  // Closed-mode bwrap with ulimit-based resource limits (maxPids/maxOpenFiles)
  // requires a `bash -c` wrapper (ulimit -u is a bash extension; /bin/sh is dash on Ubuntu).
  // Only error if /bin/bash is NOT already mounted — callers who follow this advice should not
  // be blocked from using resource limits.
  if (
    profile.filesystem.defaultReadAccess === "closed" &&
    platform === "bwrap" &&
    (profile.resources.maxPids !== undefined || profile.resources.maxOpenFiles !== undefined)
  ) {
    const allowRead = profile.filesystem.allowRead ?? [];
    const hasBashBin =
      allowRead.includes("/bin/bash") ||
      allowRead.includes("/bin") ||
      allowRead.includes("/usr/bin/bash") ||
      allowRead.includes("/usr") ||
      allowRead.includes("/");
    if (!hasBashBin) {
      return validationError(
        "Resource limits (maxPids/maxOpenFiles) require a bash -c wrapper, but /bin/bash is not " +
          "available in closed-mode bwrap sandboxes. Add '/bin/bash' (or '/bin') to allowRead, " +
          "or use defaultReadAccess: 'open'.",
      );
    }
  }

  return { ok: true, value: profile };
}
