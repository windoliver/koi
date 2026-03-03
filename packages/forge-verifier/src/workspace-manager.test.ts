/**
 * Tests for workspace-manager — brick workspace creation and caching.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyConfig } from "@koi/forge-types";
import {
  cleanupStaleWorkspaces,
  computeDependencyHash,
  createBrickWorkspace,
  resolveWorkspacePath,
  writeBrickEntry,
} from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for each test. */
function createTestDir(): string {
  return join(tmpdir(), `koi-ws-test-${crypto.randomUUID()}`);
}

/** Minimal DependencyConfig for tests that don't exercise all fields. */
const TEST_DEP_CONFIG: DependencyConfig = {
  maxDependencies: 10,
  installTimeoutMs: 5_000,
  maxCacheSizeBytes: 1_073_741_824,
  maxWorkspaceAgeDays: 30,
  maxTransitiveDependencies: 200,
  maxBrickMemoryMb: 256,
  maxBrickPids: 10,
};

// ---------------------------------------------------------------------------
// computeDependencyHash
// ---------------------------------------------------------------------------

describe("computeDependencyHash", () => {
  test("returns a non-empty string", () => {
    const hash = computeDependencyHash({ lodash: "4.17.21" });
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("returns deterministic hash for same deps", () => {
    const deps = { lodash: "4.17.21", zod: "3.22.0" };
    const hash1 = computeDependencyHash(deps);
    const hash2 = computeDependencyHash(deps);
    expect(hash1).toBe(hash2);
  });

  test("returns same hash regardless of key order", () => {
    const hash1 = computeDependencyHash({ a: "1", b: "2" });
    const hash2 = computeDependencyHash({ b: "2", a: "1" });
    expect(hash1).toBe(hash2);
  });

  test("returns different hash for different deps", () => {
    const hash1 = computeDependencyHash({ lodash: "4.17.21" });
    const hash2 = computeDependencyHash({ zod: "3.22.0" });
    expect(hash1).not.toBe(hash2);
  });

  test("returns different hash when version changes", () => {
    const hash1 = computeDependencyHash({ lodash: "4.17.21" });
    const hash2 = computeDependencyHash({ lodash: "4.17.22" });
    expect(hash1).not.toBe(hash2);
  });

  test("handles empty dependency map", () => {
    const hash = computeDependencyHash({});
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe("resolveWorkspacePath", () => {
  test("returns path under default cache dir when no cacheDir provided", () => {
    const hash = "abc123";
    const result = resolveWorkspacePath(hash);
    // Should end with the hash as the last segment
    expect(result.endsWith(hash)).toBe(true);
    // Should contain brick-workspaces in the path (default)
    expect(result).toContain("brick-workspaces");
  });

  test("returns path under custom cacheDir when provided", () => {
    const hash = "abc123";
    const customDir = "/tmp/my-custom-cache";
    const result = resolveWorkspacePath(hash, customDir);
    expect(result).toBe(join(customDir, hash));
  });

  test("includes depHash in the path", () => {
    const hash = "deadbeef1234";
    const result = resolveWorkspacePath(hash, "/tmp/cache");
    expect(result).toContain(hash);
  });
});

// ---------------------------------------------------------------------------
// writeBrickEntry
// ---------------------------------------------------------------------------

describe("writeBrickEntry", () => {
  // let justified: testDir changes per test for isolation
  let testDir: string;

  beforeEach(async () => {
    testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("creates a file with correct content", async () => {
    const implementation = 'export function hello(): string { return "hi"; }';
    await writeBrickEntry(testDir, implementation, "my-brick");

    const entryPath = join(testDir, "my-brick.ts");
    const content = await Bun.file(entryPath).text();
    expect(content).toBe(implementation);
  });

  test("returns the absolute path to the entry file", async () => {
    const implementation = "export const x = 1;";
    const result = await writeBrickEntry(testDir, implementation, "test-brick");

    expect(result).toBe(join(testDir, "test-brick.ts"));
    expect(result.startsWith("/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createBrickWorkspace — cache hit
// ---------------------------------------------------------------------------

describe("createBrickWorkspace", () => {
  // let justified: testDir changes per test for isolation
  let testDir: string;

  beforeEach(async () => {
    testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns cached result when workspace exists with node_modules", async () => {
    const packages = { lodash: "4.17.21" };
    const depHash = computeDependencyHash(packages);
    const workspacePath = join(testDir, depHash);

    // Pre-create workspace with node_modules to simulate cache hit
    await mkdir(join(workspacePath, "node_modules"), { recursive: true });

    const result = await createBrickWorkspace(packages, TEST_DEP_CONFIG, testDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cached).toBe(true);
      expect(result.value.depHash).toBe(depHash);
      expect(result.value.workspacePath).toBe(workspacePath);
    }
  });

  test("creates workspace directory and writes package.json for fresh workspace", async () => {
    // Use a non-existent package to make bun install fail fast.
    // We only verify the mkdir + package.json write steps.
    const packages = { "koi-nonexistent-pkg-abc123": "0.0.0" };
    const depHash = computeDependencyHash(packages);
    const workspacePath = join(testDir, depHash);

    // This will fail at bun install, but directory + package.json should exist
    const result = await createBrickWorkspace(packages, TEST_DEP_CONFIG, testDir);

    // bun install will fail for nonexistent package — verify the error is install-related
    if (!result.ok) {
      expect(result.error.code).toMatch(/INSTALL/);
    }

    // Verify intermediate artifacts were created
    const dirStat = await stat(workspacePath);
    expect(dirStat.isDirectory()).toBe(true);

    const pkgJsonContent = await Bun.file(join(workspacePath, "package.json")).text();
    const parsed: unknown = JSON.parse(pkgJsonContent);
    expect(parsed).toEqual({
      name: `brick-workspace-${depHash.slice(0, 8)}`,
      private: true,
      dependencies: packages,
    });
  });
});

// ---------------------------------------------------------------------------
// cleanupStaleWorkspaces
// ---------------------------------------------------------------------------

describe("cleanupStaleWorkspaces", () => {
  // let justified: testDir changes per test for isolation
  let testDir: string;

  beforeEach(async () => {
    testDir = createTestDir();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns 0 when cache dir does not exist", async () => {
    const nonExistentDir = join(testDir, "does-not-exist");
    const evicted = await cleanupStaleWorkspaces(TEST_DEP_CONFIG, nonExistentDir);
    expect(evicted).toBe(0);
  });

  test("evicts workspaces older than cutoff", async () => {
    await mkdir(testDir, { recursive: true });

    // Create a workspace directory with a marker file
    const oldWorkspace = join(testDir, "old-hash-aaa");
    await mkdir(oldWorkspace, { recursive: true });
    await writeFile(join(oldWorkspace, "package.json"), "{}");

    // Set atime to well in the past (older than maxWorkspaceAgeDays)
    const pastMs = Date.now() - 60 * 24 * 60 * 60 * 1_000; // 60 days ago
    const pastDate = new Date(pastMs);
    const { utimes } = await import("node:fs/promises");
    await utimes(oldWorkspace, pastDate, pastDate);

    const config: DependencyConfig = {
      ...TEST_DEP_CONFIG,
      maxWorkspaceAgeDays: 30,
    };

    const evicted = await cleanupStaleWorkspaces(config, testDir);
    expect(evicted).toBe(1);

    // Verify the directory was removed
    const exists = await stat(oldWorkspace)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("preserves recent workspaces", async () => {
    await mkdir(testDir, { recursive: true });

    // Create a recent workspace
    const recentWorkspace = join(testDir, "recent-hash-bbb");
    await mkdir(recentWorkspace, { recursive: true });
    await writeFile(join(recentWorkspace, "package.json"), "{}");
    // Access time is now (within maxWorkspaceAgeDays), so should survive

    const config: DependencyConfig = {
      ...TEST_DEP_CONFIG,
      maxWorkspaceAgeDays: 30,
    };

    const evicted = await cleanupStaleWorkspaces(config, testDir);
    expect(evicted).toBe(0);

    // Verify the directory still exists
    const dirStat = await stat(recentWorkspace);
    expect(dirStat.isDirectory()).toBe(true);
  });

  test("returns 0 for empty cache directory", async () => {
    await mkdir(testDir, { recursive: true });
    const evicted = await cleanupStaleWorkspaces(TEST_DEP_CONFIG, testDir);
    expect(evicted).toBe(0);
  });
});
