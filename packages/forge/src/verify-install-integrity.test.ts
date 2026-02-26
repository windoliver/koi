/**
 * Tests for post-install integrity verification.
 *
 * Creates real temp workspaces with bun.lock and node_modules
 * to verify the integrity checker catches mismatches.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInstallIntegrity } from "./verify-install-integrity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `integrity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

async function createWorkspace(
  name: string,
  opts: {
    readonly lockContent?: string;
    readonly packages?: ReadonlyArray<{
      readonly name: string;
      readonly version: string;
    }>;
  },
): Promise<string> {
  const wsPath = join(TEST_DIR, name);
  await mkdir(wsPath, { recursive: true });

  if (opts.lockContent !== undefined) {
    await writeFile(join(wsPath, "bun.lock"), opts.lockContent, "utf8");
  }

  if (opts.packages !== undefined) {
    for (const pkg of opts.packages) {
      const pkgDir = join(wsPath, "node_modules", pkg.name);
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg.name, version: pkg.version }),
        "utf8",
      );
    }
  }

  return wsPath;
}

/**
 * Build a minimal bun.lock JSONC content from a list of packages.
 * Format: { "packages": { "<name>": ["<name>@<version>"] } }
 */
function buildLockContent(
  packages: ReadonlyArray<{ readonly name: string; readonly version: string }>,
): string {
  const pkgEntries: Record<string, [string]> = {};
  for (const pkg of packages) {
    pkgEntries[pkg.name] = [`${pkg.name}@${pkg.version}`];
  }
  return JSON.stringify({ packages: pkgEntries }, null, 2);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyInstallIntegrity", () => {
  test("passes when lockfile and node_modules match declared packages", async () => {
    const packages = [{ name: "zod", version: "3.23.8" }];
    const wsPath = await createWorkspace("match", {
      lockContent: buildLockContent(packages),
      packages,
    });

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(true);
  });

  test("passes with multiple packages", async () => {
    const packages = [
      { name: "zod", version: "3.23.8" },
      { name: "lodash", version: "4.17.21" },
    ];
    const wsPath = await createWorkspace("multi-match", {
      lockContent: buildLockContent(packages),
      packages,
    });

    const result = await verifyInstallIntegrity(wsPath, {
      zod: "3.23.8",
      lodash: "4.17.21",
    });
    expect(result.ok).toBe(true);
  });

  test("skips verification when declaredPackages is empty", async () => {
    const result = await verifyInstallIntegrity("/nonexistent/path", {});
    expect(result.ok).toBe(true);
  });

  test("fails when bun.lock is missing", async () => {
    const wsPath = await createWorkspace("no-lock", {
      packages: [{ name: "zod", version: "3.23.8" }],
    });

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("resolve");
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("bun.lock");
    }
  });

  test("fails when package is missing from lockfile", async () => {
    const wsPath = await createWorkspace("missing-from-lock", {
      lockContent: buildLockContent([]),
      packages: [{ name: "zod", version: "3.23.8" }],
    });

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("not found in bun.lock");
    }
  });

  test("fails when lockfile version doesn't match declared version", async () => {
    const wsPath = await createWorkspace("version-mismatch-lock", {
      lockContent: buildLockContent([{ name: "zod", version: "3.22.0" }]),
      packages: [{ name: "zod", version: "3.22.0" }],
    });

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("version mismatch");
      expect(result.error.message).toContain("3.23.8");
      expect(result.error.message).toContain("3.22.0");
    }
  });

  test("fails when package is missing from node_modules", async () => {
    const wsPath = await createWorkspace("missing-from-nm", {
      lockContent: buildLockContent([{ name: "zod", version: "3.23.8" }]),
      // No packages installed in node_modules
    });

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("not found in node_modules");
    }
  });

  test("fails when installed version doesn't match declared version", async () => {
    const wsPath = await createWorkspace("version-mismatch-nm", {
      lockContent: buildLockContent([{ name: "zod", version: "3.23.8" }]),
      packages: [{ name: "zod", version: "3.22.0" }], // wrong installed version
    });

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("installed version mismatch");
    }
  });

  test("handles scoped packages (@scope/name)", async () => {
    const packages = [{ name: "@anthropic/sdk", version: "1.0.0" }];
    const wsPath = await createWorkspace("scoped", {
      lockContent: buildLockContent(packages),
      packages,
    });

    const result = await verifyInstallIntegrity(wsPath, { "@anthropic/sdk": "1.0.0" });
    expect(result.ok).toBe(true);
  });

  test("fails when bun.lock contains invalid JSON", async () => {
    const wsPath = await createWorkspace("bad-json", {
      lockContent: "this is not json at all",
      packages: [{ name: "zod", version: "3.23.8" }],
    });

    const result = await verifyInstallIntegrity(wsPath, { zod: "3.23.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("malformed");
    }
  });

  test("handles scoped package missing from lockfile", async () => {
    const wsPath = await createWorkspace("scoped-missing", {
      lockContent: buildLockContent([]),
      packages: [{ name: "@anthropic/sdk", version: "1.0.0" }],
    });

    const result = await verifyInstallIntegrity(wsPath, { "@anthropic/sdk": "1.0.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTEGRITY_MISMATCH");
      expect(result.error.message).toContain("@anthropic/sdk");
    }
  });
});
