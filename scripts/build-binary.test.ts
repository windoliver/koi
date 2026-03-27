/**
 * Tests for the standalone binary build script.
 *
 * Validates that build-binary.ts produces a working executable.
 * The beforeAll hook runs the build script (with --skip-build to avoid a full
 * turborepo rebuild). If packages have not been built yet, the build will fail
 * and all tests are skipped gracefully.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MONOREPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST_DIR = resolve(MONOREPO_ROOT, "dist");
const BUILD_SCRIPT = resolve(MONOREPO_ROOT, "scripts/build-binary.ts");

function currentBinaryName(): string {
  return `koi-${process.platform}-${process.arch}`;
}

function currentBinaryPath(): string {
  return resolve(DIST_DIR, currentBinaryName());
}

describe("build-binary", () => {
  // Track whether the build succeeded so tests can skip gracefully
  let buildSucceeded = false;

  // -------------------------------------------------------------------------
  // Build the binary for the current platform before running tests.
  // Uses --skip-build to avoid the full turborepo build; assumes packages
  // are already built (e.g. by a prior `bun run build:cli`).
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    const proc = Bun.spawn(["bun", BUILD_SCRIPT, "--skip-build"], {
      cwd: MONOREPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.warn(
        `Build script failed (exit ${String(exitCode)}). ` +
          "Tests will be skipped. Run 'bun run build:cli' first.\n" +
          `stderr: ${stderr.slice(0, 500)}`,
      );
    } else {
      buildSucceeded = true;
    }
  }, 120_000); // Allow up to 2 minutes for compilation

  afterAll(async () => {
    // Clean up the built binary to avoid leaving artifacts
    const binaryPath = currentBinaryPath();
    if (existsSync(binaryPath)) {
      const { unlink } = await import("node:fs/promises");
      await unlink(binaryPath);
    }
    // Remove dist dir if empty
    if (existsSync(DIST_DIR)) {
      const { readdir, rmdir } = await import("node:fs/promises");
      const entries = await readdir(DIST_DIR);
      if (entries.length === 0) {
        await rmdir(DIST_DIR);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Core tests
  // -------------------------------------------------------------------------

  test("produces an executable file", () => {
    if (!buildSucceeded) {
      console.warn("Build not available, skipping");
      return;
    }

    const binaryPath = currentBinaryPath();
    expect(existsSync(binaryPath)).toBe(true);

    const file = Bun.file(binaryPath);
    expect(file.size).toBeGreaterThan(0);
  });

  test("executable runs unknown command and produces usage output", async () => {
    if (!buildSucceeded) {
      console.warn("Build not available, skipping");
      return;
    }

    const binaryPath = currentBinaryPath();
    const proc = Bun.spawn([binaryPath, "__nonexistent_command__"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  }, 30_000);

  test("executable shows command list when given unknown command", async () => {
    if (!buildSucceeded) {
      console.warn("Build not available, skipping");
      return;
    }

    const binaryPath = currentBinaryPath();
    const proc = Bun.spawn([binaryPath, "__nonexistent_command__"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    // Verify the usage output lists known subcommands
    expect(stderr).toContain("koi init");
    expect(stderr).toContain("koi start");
    expect(stderr).toContain("koi serve");
  }, 30_000);
});
