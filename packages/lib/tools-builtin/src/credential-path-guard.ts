/**
 * Credential path guard — defense-in-depth layer that blocks filesystem access
 * to directories known to contain secrets, independent of the permission system.
 *
 * This guard resolves `os.homedir()` at construction time and checks resolved
 * absolute paths against a hardcoded set of sensitive directory prefixes.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/** Result of a path guard check. */
export type PathGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const ALLOWED: PathGuardResult = { ok: true };

/** Sensitive directory suffixes (appended to homedir). */
const SENSITIVE_DIR_SUFFIXES: readonly string[] = [
  "/.ssh/",
  "/.docker/",
  "/.aws/",
  "/.gnupg/",
  "/.config/gcloud/",
  "/.azure/",
  "/.kube/",
];

/** Sensitive file basenames (exact match after homedir). */
const SENSITIVE_FILE_SUFFIXES: readonly string[] = [
  "/.npmrc",
  "/.pypirc",
  "/.netrc",
  "/.vault-token",
];

/** Reason messages for blocked paths. */
const REASON_MAP: Readonly<Record<string, string>> = {
  "/.ssh/": "SSH keys — credential directory access blocked",
  "/.docker/": "Docker credentials — credential directory access blocked",
  "/.aws/": "AWS credentials — credential directory access blocked",
  "/.gnupg/": "GPG keys — credential directory access blocked",
  "/.config/gcloud/": "Google Cloud credentials — credential directory access blocked",
  "/.azure/": "Azure CLI credentials — credential directory access blocked",
  "/.kube/": "Kubernetes configs — credential directory access blocked",
  "/.npmrc": "npm auth tokens — credential file access blocked",
  "/.pypirc": "PyPI auth tokens — credential file access blocked",
  "/.netrc": "Network credentials — credential file access blocked",
  "/.vault-token": "HashiCorp Vault token — credential file access blocked",
};

/**
 * Create a credential path guard that checks resolved paths against known
 * credential directories. The guard is pure after construction (no I/O).
 *
 * @param home - Override for `os.homedir()` (for testing). Defaults to `os.homedir()`.
 */
export function createCredentialPathGuard(
  home?: string,
): (resolvedPath: string) => PathGuardResult {
  const homeDir = resolve(home ?? homedir());

  // Pre-compute blocked directory prefixes and exact file paths
  const blockedPrefixes: readonly { readonly prefix: string; readonly reason: string }[] =
    SENSITIVE_DIR_SUFFIXES.map((suffix) => ({
      prefix: `${homeDir}${suffix}`,
      reason: REASON_MAP[suffix] ?? "Credential directory access blocked",
    }));

  const blockedFiles: readonly { readonly path: string; readonly reason: string }[] =
    SENSITIVE_FILE_SUFFIXES.map((suffix) => ({
      path: `${homeDir}${suffix}`,
      reason: REASON_MAP[suffix] ?? "Credential file access blocked",
    }));

  return function checkPath(resolvedPath: string): PathGuardResult {
    const normalized = resolve(resolvedPath);

    // Check directory prefixes
    for (const entry of blockedPrefixes) {
      if (normalized.startsWith(entry.prefix)) {
        return { ok: false, reason: entry.reason };
      }
    }

    // Check exact file paths
    for (const entry of blockedFiles) {
      if (normalized === entry.path) {
        return { ok: false, reason: entry.reason };
      }
    }

    return ALLOWED;
  };
}
