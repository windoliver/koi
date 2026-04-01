/**
 * Platform detection and sandbox availability checking.
 */

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

export function detectPlatform(): Result<SandboxPlatform, KoiError> {
  const os = process.platform;
  if (os === "darwin") {
    return { ok: true, value: "seatbelt" };
  }
  if (os === "linux") {
    return { ok: true, value: "bwrap" };
  }
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: `Unsupported platform: ${os}. Only macOS (seatbelt) and Linux (bwrap) are supported.`,
      retryable: false,
    },
  };
}

export function checkAvailability(): Result<PlatformInfo, KoiError> {
  const platform = detectPlatform();
  if (!platform.ok) {
    return platform;
  }

  const binary = PLATFORM_BINARIES[platform.value];
  const path = Bun.which(binary);

  if (path === null) {
    return {
      ok: true,
      value: {
        platform: platform.value,
        available: false,
        reason: `Binary '${binary}' not found in PATH`,
      },
    };
  }

  return {
    ok: true,
    value: { platform: platform.value, available: true },
  };
}
