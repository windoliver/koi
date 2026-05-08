import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(TEST_DIR, "..", "..");
const FIXTURE = join(TEST_DIR, "fixtures", "workflows-boundary.ts");
const AMBIENT = join(TEST_DIR, "fixtures", "workflows-boundary.ambient.d.ts");

function runTypecheckFixture() {
  return spawnSync(
    "bunx",
    [
      "tsc",
      "--noEmit",
      "--ignoreConfig",
      "--pretty",
      "false",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ES2022,DOM,ESNext.Disposable",
      "--noImplicitAny",
      "false",
      "--noImplicitReturns",
      "false",
      "--strict",
      "false",
      "--strictNullChecks",
      "false",
      FIXTURE,
      AMBIENT,
    ],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    },
  );
}

describe("temporal workflow public surface", () => {
  test("exports Koi-owned workflow type names through the package boundary", () => {
    const result = runTypecheckFixture();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);
});
