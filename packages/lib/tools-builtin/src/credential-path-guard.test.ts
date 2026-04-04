import { describe, expect, test } from "bun:test";
import { createCredentialPathGuard } from "./credential-path-guard.js";

const MOCK_HOME = "/home/testuser";

function createGuard() {
  return createCredentialPathGuard(MOCK_HOME);
}

describe("createCredentialPathGuard", () => {
  // Blocked credential directories
  const blockedPaths: readonly [string, string][] = [
    ["/home/testuser/.ssh/id_rsa", "SSH keys"],
    ["/home/testuser/.ssh/authorized_keys", "SSH keys"],
    ["/home/testuser/.ssh/config", "SSH keys"],
    ["/home/testuser/.docker/config.json", "Docker credentials"],
    ["/home/testuser/.aws/credentials", "AWS credentials"],
    ["/home/testuser/.aws/config", "AWS credentials"],
    ["/home/testuser/.gnupg/secring.gpg", "GPG keys"],
    ["/home/testuser/.config/gcloud/credentials.db", "Google Cloud credentials"],
    ["/home/testuser/.azure/accessTokens.json", "Azure CLI credentials"],
    ["/home/testuser/.kube/config", "Kubernetes configs"],
  ];

  for (const [path, desc] of blockedPaths) {
    test(`blocks ${desc}: ${path}`, () => {
      const guard = createGuard();
      const result = guard(path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("blocked");
      }
    });
  }

  // Blocked credential files
  const blockedFiles: readonly [string, string][] = [
    ["/home/testuser/.npmrc", "npm auth tokens"],
    ["/home/testuser/.pypirc", "PyPI auth tokens"],
    ["/home/testuser/.netrc", "Network credentials"],
    ["/home/testuser/.vault-token", "HashiCorp Vault token"],
  ];

  for (const [path, desc] of blockedFiles) {
    test(`blocks ${desc}: ${path}`, () => {
      const guard = createGuard();
      const result = guard(path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("blocked");
      }
    });
  }

  // Safe paths that must NOT be blocked
  const safePaths = [
    "/home/testuser/project/src/index.ts",
    "/home/testuser/project/.config/other/file.json",
    "/home/testuser/.config/Code/settings.json",
    "/home/testuser/project/ssh/config",
    "/home/testuser/project/docker/Dockerfile",
    "/home/testuser/.bashrc",
    "/home/testuser/.gitconfig",
    "/tmp/somefile",
    "/var/data/output.json",
  ];

  for (const path of safePaths) {
    test(`allows safe path: ${path}`, () => {
      const guard = createGuard();
      const result = guard(path);
      expect(result.ok).toBe(true);
    });
  }

  test("resolves relative paths before checking", () => {
    const guard = createGuard();
    // This path should resolve and not match credential dirs
    const result = guard("/home/testuser/project/../project/src/file.ts");
    expect(result.ok).toBe(true);
  });

  test("blocks paths with traversal into credential dirs", () => {
    const guard = createGuard();
    // Path that traverses into .ssh via ..
    const result = guard("/home/testuser/project/../.ssh/id_rsa");
    expect(result.ok).toBe(false);
  });

  test("does not block .env files in other users home dirs", () => {
    const guard = createGuard();
    // Different home directory — not under MOCK_HOME
    const result = guard("/home/otheruser/.ssh/id_rsa");
    expect(result.ok).toBe(true);
  });

  test("uses os.homedir() when no override provided", () => {
    // Just verify construction doesn't throw
    const guard = createCredentialPathGuard();
    const result = guard("/tmp/safe-file.txt");
    expect(result.ok).toBe(true);
  });
});
