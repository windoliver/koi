/**
 * Integration test for workspace manager — real filesystem operations.
 *
 * Gated by WORKSPACE_INTEGRATION=1 environment variable.
 * Run: WORKSPACE_INTEGRATION=1 bun test packages/forge/src/__tests__/workspace-integration.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyConfig } from "@koi/forge-types";
import {
  cleanupStaleWorkspaces,
  computeDependencyHash,
  createBrickWorkspace,
  resolveWorkspacePath,
  writeBrickEntry,
} from "@koi/forge-verifier";

const ENABLED = process.env.WORKSPACE_INTEGRATION === "1";
const describeIntegration = ENABLED ? describe : describe.skip;

const TEST_CACHE_DIR = join(tmpdir(), `koi-ws-test-${Date.now()}`);

const TEST_CONFIG: DependencyConfig = {
  maxDependencies: 20,
  installTimeoutMs: 30_000,
  maxCacheSizeBytes: 1_073_741_824,
  maxWorkspaceAgeDays: 30,
  maxTransitiveDependencies: 200,
  maxBrickMemoryMb: 256,
  maxBrickPids: 32,
};

afterAll(async () => {
  if (ENABLED) {
    await rm(TEST_CACHE_DIR, { recursive: true, force: true });
  }
});

describeIntegration("workspace-manager (integration)", () => {
  test("creates workspace and installs a small package", async () => {
    const packages = { "is-number": "7.0.0" };
    const result = await createBrickWorkspace(packages, TEST_CONFIG, TEST_CACHE_DIR);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cached).toBe(false);
      expect(result.value.depHash).toBe(computeDependencyHash(packages));

      // Verify node_modules exists
      const nmStat = await stat(join(result.value.workspacePath, "node_modules"));
      expect(nmStat.isDirectory()).toBe(true);
    }
  });

  test("reuses cached workspace on second call", async () => {
    const packages = { "is-number": "7.0.0" };
    const result = await createBrickWorkspace(packages, TEST_CONFIG, TEST_CACHE_DIR);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cached).toBe(true);
    }
  });

  test("writes brick entry file", async () => {
    const depHash = computeDependencyHash({ "is-number": "7.0.0" });
    const workspacePath = resolveWorkspacePath(depHash, TEST_CACHE_DIR);

    const implementation = 'import isNumber from "is-number";\nreturn isNumber(input);';
    const entryPath = await writeBrickEntry(workspacePath, implementation, "test-brick");

    expect(entryPath).toContain("test-brick.ts");
    const entryStat = await stat(entryPath);
    expect(entryStat.isFile()).toBe(true);
  });

  test("cleanupStaleWorkspaces handles empty directory", async () => {
    const evicted = await cleanupStaleWorkspaces(TEST_CONFIG, join(tmpdir(), "nonexistent"));
    expect(evicted).toBe(0);
  });
});
