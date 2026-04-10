import { readFileSync } from "node:fs";

import type { KoiError, Result } from "@koi/core";

export type SandboxPlatform = "seatbelt" | "bwrap";

/**
 * Typed discriminant for sandbox unavailability reasons.
 * Set in KoiError.context.sandboxCode so callers can branch without
 * parsing error message strings.
 */
export type SandboxErrorCode =
  | "BWRAP_NOT_FOUND"
  | "SEATBELT_NOT_FOUND"
  | "APPARMOR_RESTRICTED"
  | "UNSUPPORTED_PLATFORM"
  | "WSL1"
  | "ARCH_UNSUPPORTED";

export interface PlatformInfo {
  readonly platform: SandboxPlatform;
  readonly available: boolean;
  readonly reason?: string;
}

const PLATFORM_BINARIES: Readonly<Record<SandboxPlatform, string>> = {
  seatbelt: "sandbox-exec",
  bwrap: "bwrap",
};

// Module-level cache — kernel.apparmor_restrict_unprivileged_userns is a
// sysctl that never changes while a process is running (requires sudo to change).
// Re-reading it on every createOsAdapter() call is wasteful.
let cachedAppArmorRestricted: boolean | undefined;

// Module-level cache for the bwrap user-namespace probe result.
let cachedBwrapUsable: boolean | undefined;

function validationError(message: string, sandboxCode?: SandboxErrorCode): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
      ...(sandboxCode !== undefined ? { context: { sandboxCode } } : {}),
    },
  };
}

/**
 * Check whether the Ubuntu AppArmor user-namespace restriction is active.
 *
 * Ubuntu 23.10+ introduced kernel.apparmor_restrict_unprivileged_userns as
 * an opt-in restriction; Ubuntu 24.04 (now ubuntu-latest on GitHub Actions)
 * enables it by default. When active, `bwrap --unshare-net` fails at spawn
 * time with "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted".
 *
 * Fix: add an AppArmor profile for bwrap at /etc/apparmor.d/bwrap, or
 * disable the restriction (not recommended on production systems):
 *   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
 *
 * Result is cached — the sysctl doesn't change at runtime.
 */
export function isAppArmorUserNsRestricted(): boolean {
  if (cachedAppArmorRestricted !== undefined) return cachedAppArmorRestricted;
  try {
    const val = readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8");
    cachedAppArmorRestricted = val.trim() === "1";
  } catch {
    // File absent = not Ubuntu, or restriction not configured.
    cachedAppArmorRestricted = false;
  }
  return cachedAppArmorRestricted;
}

/**
 * Probe whether bwrap can actually run with the full namespace set the sandbox uses.
 *
 * The sysctl `kernel.apparmor_restrict_unprivileged_userns=1` is a
 * necessary-but-not-sufficient condition for bwrap failure: if an AppArmor
 * profile grants bwrap the `userns` capability (e.g. from the `bubblewrap`
 * package), bwrap still works even with the sysctl set.  Reading the sysctl
 * alone causes false positives that silently disable sandboxing on
 * well-configured Ubuntu systems.
 *
 * This probe uses `--unshare-all` (the same flag the sandbox always uses) so
 * the result accurately reflects whether the real sandbox invocation will succeed.
 * `--ro-bind / /` + `--dev /dev` + `--proc /proc` + `--tmpfs /tmp` mirrors the
 * minimal open-mode sandbox prefix, exercising the same kernel namespace code path.
 *
 * This probe runs one minimal bwrap invocation and caches the result.
 * Called only when `isAppArmorUserNsRestricted()` returns true.
 */
function probeBwrapUserNs(): boolean {
  if (cachedBwrapUsable !== undefined) return cachedBwrapUsable;
  try {
    const proc = Bun.spawnSync(
      [
        "bwrap",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--",
        "true",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    cachedBwrapUsable = proc.exitCode === 0;
  } catch {
    cachedBwrapUsable = false;
  }
  return cachedBwrapUsable;
}

export function detectPlatform(): Result<SandboxPlatform, KoiError> {
  if (process.platform === "darwin") {
    return { ok: true, value: "seatbelt" };
  }

  if (process.platform === "linux") {
    if (process.arch === "ia32") {
      return validationError(
        "32-bit x86 is not supported for sandbox execution.",
        "ARCH_UNSUPPORTED",
      );
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
          "WSL1",
        );
      }
    } catch {
      // Ignore /proc/version read failures and assume native Linux.
    }

    if (isAppArmorUserNsRestricted() && !probeBwrapUserNs()) {
      return validationError(
        "Ubuntu AppArmor restricts unprivileged user namespace creation " +
          "(kernel.apparmor_restrict_unprivileged_userns=1). " +
          "bubblewrap --unshare-net will fail at spawn time. " +
          "Fix: add /etc/apparmor.d/bwrap with 'userns' permission, or " +
          "run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
        "APPARMOR_RESTRICTED",
      );
    }

    return { ok: true, value: "bwrap" };
  }

  if (process.platform === "win32") {
    return validationError("Windows not supported for OS sandboxing.", "UNSUPPORTED_PLATFORM");
  }

  return validationError(`Unsupported platform: ${process.platform}`, "UNSUPPORTED_PLATFORM");
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
