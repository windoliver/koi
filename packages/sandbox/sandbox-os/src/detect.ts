import { readFileSync } from "node:fs";

import type { KoiError, Result } from "@koi/core";

export type SandboxPlatform = "seatbelt" | "bwrap";

export interface PlatformInfo {
  readonly platform: SandboxPlatform;
  readonly available: boolean;
  readonly reason?: string;
}

const PLATFORM_BINARIES: Readonly<Record<SandboxPlatform, string>> = {
  seatbelt: "sandbox-exec",
  bwrap: "bwrap",
};

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

export function detectPlatform(): Result<SandboxPlatform, KoiError> {
  if (process.platform === "darwin") {
    return { ok: true, value: "seatbelt" };
  }

  if (process.platform === "linux") {
    if (process.arch === "ia32") {
      return validationError("32-bit x86 is not supported for sandbox execution.");
    }

    try {
      const procVersion = readFileSync("/proc/version", "utf8");
      // WSL2 has "WSL2" in the version string and supports kernel namespaces.
      // WSL1 contains "Microsoft" without "WSL2" and uses translation layer — reject it.
      const isWsl2 = /WSL2/i.test(procVersion);
      const isWsl1 = !isWsl2 && procVersion.includes("Microsoft");
      if (isWsl1) {
        return validationError(
          "WSL1 not supported for OS sandboxing. bubblewrap requires kernel namespaces; use WSL2.",
        );
      }
    } catch {
      // Ignore /proc/version read failures and assume native Linux.
    }

    return { ok: true, value: "bwrap" };
  }

  if (process.platform === "win32") {
    return validationError("Windows not supported for OS sandboxing.");
  }

  return validationError(`Unsupported platform: ${process.platform}`);
}

export async function checkAvailability(
  platform: SandboxPlatform,
): Promise<{ available: boolean; reason?: string }> {
  const binary = PLATFORM_BINARIES[platform];
  const resolved = Bun.which(binary);

  if (resolved === null) {
    return {
      available: false,
      reason: `Binary '${binary}' not found in PATH`,
    };
  }

  return { available: true };
}
