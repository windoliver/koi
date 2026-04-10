/**
 * Platform-detecting factory for SecureStorage.
 *
 * Returns the appropriate keychain implementation for the current OS.
 * Throws on unsupported platforms — no insecure fallback.
 */

import { platform } from "node:os";
import { createLinuxSecretStorage } from "./keychain-linux.js";
import { createMacOsKeychainStorage } from "./keychain-macos.js";
import type { SecureStorage } from "./types.js";

/**
 * Creates a SecureStorage backed by the OS keychain.
 *
 * - macOS: Keychain Services via `security` CLI
 * - Linux: libsecret via `secret-tool` CLI
 * - Other: throws (no insecure fallback)
 *
 * @param lockDir - Optional custom directory for lock files.
 *   Defaults to `~/.koi/locks/`.
 */
export function createSecureStorage(lockDir?: string): SecureStorage {
  const os = platform();

  switch (os) {
    case "darwin":
      return createMacOsKeychainStorage(lockDir);
    case "linux":
      return createLinuxSecretStorage(lockDir);
    default:
      throw new Error(
        `No secure storage available on platform "${os}". ` +
          "Koi requires macOS Keychain or Linux libsecret (secret-tool) for credential storage.",
      );
  }
}
