/**
 * macOS Keychain storage via `security` CLI.
 *
 * Uses `security find-generic-password` / `security add-generic-password`
 * to store credentials in the user's default keychain. Same approach as
 * Claude Code's `macOsKeychainStorage`.
 */

import { createFileLock } from "./lock.js";
import type { SecureStorage } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_NAME = "koi-secure-storage";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMacOsKeychainStorage(lockDir?: string): SecureStorage {
  const lock = createFileLock(lockDir);

  const get = async (key: string): Promise<string | undefined> => {
    try {
      const proc = Bun.spawn(
        ["security", "find-generic-password", "-a", key, "-s", SERVICE_NAME, "-w"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) return undefined;
      const text = await new Response(proc.stdout).text();
      return text.trimEnd();
    } catch {
      return undefined;
    }
  };

  const set = async (key: string, value: string): Promise<void> => {
    // Delete first to avoid "already exists" error, then add
    await runSecurity(["delete-generic-password", "-a", key, "-s", SERVICE_NAME]);
    const exitCode = await runSecurity([
      "add-generic-password",
      "-a",
      key,
      "-s",
      SERVICE_NAME,
      "-w",
      value,
      "-U", // Update if exists (race condition safety)
    ]);
    if (exitCode !== 0) {
      throw new Error(`Failed to store credential in macOS Keychain (exit ${exitCode})`);
    }
  };

  const del = async (key: string): Promise<boolean> => {
    const exitCode = await runSecurity(["delete-generic-password", "-a", key, "-s", SERVICE_NAME]);
    return exitCode === 0;
  };

  return {
    get,
    set,
    delete: del,
    withLock: lock.withLock,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runSecurity(args: readonly string[]): Promise<number> {
  try {
    const proc = Bun.spawn(["security", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exited;
  } catch {
    return 1;
  }
}
