/**
 * @koi/secure-storage — OS keychain token storage with file-based locking.
 *
 * Provides a platform-aware SecureStorage interface backed by:
 * - macOS: Keychain Services via `security` CLI
 * - Linux: libsecret via `secret-tool` CLI
 * - Unsupported: throws with clear error
 *
 * All implementations include file-based locking for safe concurrent access
 * across processes (agent + CLI).
 */

export { createSecureStorage } from "./factory.js";
export { createFileLock, type FileLock } from "./lock.js";
export type { SecureStorage } from "./types.js";
