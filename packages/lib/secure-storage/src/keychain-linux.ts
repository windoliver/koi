/**
 * Linux Secret Service storage via `secret-tool` CLI.
 *
 * Uses `secret-tool store` / `secret-tool lookup` / `secret-tool clear`
 * to interact with the system's secret service (GNOME Keyring, KWallet, etc.)
 * via the D-Bus Secret Service API.
 */

import { createFileLock } from "./lock.js";
import type { SecureStorage } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATTRIBUTE_SERVICE = "koi-secure-storage";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLinuxSecretStorage(lockDir?: string): SecureStorage {
  const lock = createFileLock(lockDir);

  const get = async (key: string): Promise<string | undefined> => {
    try {
      const proc = Bun.spawn(["secret-tool", "lookup", "service", ATTRIBUTE_SERVICE, "key", key], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) return undefined;
      const text = await new Response(proc.stdout).text();
      const trimmed = text.trimEnd();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  };

  const set = async (key: string, value: string): Promise<void> => {
    const proc = Bun.spawn(
      ["secret-tool", "store", "--label", `koi: ${key}`, "service", ATTRIBUTE_SERVICE, "key", key],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: new TextEncoder().encode(value),
      },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to store credential via secret-tool (exit ${exitCode})`);
    }
  };

  const del = async (key: string): Promise<boolean> => {
    try {
      const proc = Bun.spawn(["secret-tool", "clear", "service", ATTRIBUTE_SERVICE, "key", key], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  };

  return {
    get,
    set,
    delete: del,
    withLock: lock.withLock,
  };
}
