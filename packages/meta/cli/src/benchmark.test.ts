/**
 * Startup time regression gate (Decision 13-A).
 *
 * Verifies that --version and --help fast-paths complete within 150ms.
 * This prevents silent startup regressions as commands are added — the primary
 * value of lazy loading is a measurable startup guarantee, not an abstract one.
 *
 * If this test flakes due to CI machine load, raise the threshold rather than
 * removing the test. The threshold is a regression detector, not a perf target.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = resolve(fileURLToPath(new URL(".", import.meta.url)), "bin.ts");
const STARTUP_LIMIT_MS = 150;

describe("CLI startup time", () => {
  test(`koi --version exits 0 in under ${String(STARTUP_LIMIT_MS)}ms`, () => {
    const start = performance.now();
    const result = Bun.spawnSync(["bun", "run", BIN_PATH, "--version"]);
    const elapsed = performance.now() - start;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(STARTUP_LIMIT_MS);
  });

  test(`koi --help exits 0 in under ${String(STARTUP_LIMIT_MS)}ms`, () => {
    const start = performance.now();
    const result = Bun.spawnSync(["bun", "run", BIN_PATH, "--help"]);
    const elapsed = performance.now() - start;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(STARTUP_LIMIT_MS);
  });

  test(`koi (no args) exits 0 in under ${String(STARTUP_LIMIT_MS)}ms`, () => {
    const start = performance.now();
    const result = Bun.spawnSync(["bun", "run", BIN_PATH]);
    const elapsed = performance.now() - start;

    // No args shows help and exits 0
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(STARTUP_LIMIT_MS);
  });
});
