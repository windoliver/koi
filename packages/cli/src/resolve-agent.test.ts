/**
 * Tests for resolve-agent — verifies that all descriptors are registered
 * and dynamic discovery integrates correctly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descriptor as externalEngineDescriptor } from "@koi/engine-external";
import type { BrickDescriptor } from "@koi/resolve";
import { createRegistry } from "@koi/resolve";

describe("CLI descriptor registration", () => {
  test("external engine descriptor has correct kind and name", () => {
    expect(externalEngineDescriptor.kind).toBe("engine");
    expect(externalEngineDescriptor.name).toBe("@koi/engine-external");
  });

  test("external engine descriptor has 'external' alias", () => {
    expect(externalEngineDescriptor.aliases).toContain("external");
  });

  test("registry resolves engine/external by alias", () => {
    const regResult = createRegistry([externalEngineDescriptor as BrickDescriptor<unknown>]);
    if (!regResult.ok) throw new Error("Registry creation failed");

    const found = regResult.value.get("engine", "external");
    expect(found).toBeDefined();
    expect(found?.name).toBe("@koi/engine-external");
  });
});

// ---------------------------------------------------------------------------
// Discovery integration tests
// ---------------------------------------------------------------------------

const { resolveAgent } = await import("./resolve-agent.js");

function makeTempDir(): string {
  const dir = join(tmpdir(), `koi-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

describe("resolveAgent — discovery integration", () => {
  test("discovery failure degrades gracefully", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const manifestPath = join(dir, "koi.yaml");
    writeFileSync(
      manifestPath,
      ["name: test-agent", "version: 0.1.0", "model:", "  name: anthropic:test"].join("\n"),
    );

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      // Point to nonexistent packagesDir — discovery should fail gracefully
      const result = await resolveAgent({
        manifestPath,
        manifest: {
          name: "test-agent",
          version: "0.1.0",
          model: { name: "anthropic:test" },
        },
        packagesDir: "/nonexistent/packages",
      });

      // Should still attempt resolution (will fail at model because no API key,
      // but that means discovery didn't block it)
      const output = stderrChunks.join("");
      expect(output).toContain("warn: descriptor discovery failed");

      // The result may fail due to missing API key, but that's expected —
      // the point is discovery didn't prevent resolution from running
      expect(result).toBeDefined();
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("resolveAgent accepts packagesDir option", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const manifestPath = join(dir, "koi.yaml");
    writeFileSync(
      manifestPath,
      ["name: test-agent", "version: 0.1.0", "model:", "  name: anthropic:test"].join("\n"),
    );

    // Empty packagesDir — no descriptors to discover, but no error
    const packagesDir = makeTempDir();
    tempDirs.push(packagesDir);

    const result = await resolveAgent({
      manifestPath,
      manifest: {
        name: "test-agent",
        version: "0.1.0",
        model: { name: "anthropic:test" },
      },
      packagesDir,
    });

    // Will fail due to missing API key, but discovery succeeded (no crash)
    expect(result).toBeDefined();
  });
});
