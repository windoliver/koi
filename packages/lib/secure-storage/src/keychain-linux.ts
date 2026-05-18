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
// Helpers
// ---------------------------------------------------------------------------

function spawnSecretTool(args: readonly string[], stdin?: Uint8Array) {
  return Bun.spawn(["secret-tool", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin !== undefined ? { stdin } : {}),
  });
}

async function clearSecret(key: string): Promise<boolean> {
  try {
    const proc = spawnSecretTool(["clear", "service", ATTRIBUTE_SERVICE, "key", key]);
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLinuxSecretStorage(lockDir?: string): SecureStorage {
  const lock = createFileLock(lockDir);

  const get = async (key: string): Promise<string | undefined> => {
    try {
      const proc = spawnSecretTool(["lookup", "service", ATTRIBUTE_SERVICE, "key", key]);
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
    const proc = spawnSecretTool(
      ["secret-tool", "store", "--label", `koi: ${key}`, "service", ATTRIBUTE_SERVICE, "key", key],
      new TextEncoder().encode(value),
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to store credential via secret-tool (exit ${exitCode})`);
    }
  };

  return {
    get,
    set,
    delete: clearSecret,
    withLock: lock.withLock,
  };
}
