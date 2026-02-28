/**
 * Tests for discoverDescriptors — dynamic package discovery.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDescriptors } from "./discover.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `koi-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

function createMockPackage(
  packagesDir: string,
  name: string,
  descriptor?: { readonly kind: string; readonly name: string },
): void {
  const distDir = join(packagesDir, name, "dist");
  mkdirSync(distDir, { recursive: true });

  if (descriptor !== undefined) {
    const content = `
export const descriptor = {
  kind: "${descriptor.kind}",
  name: "${descriptor.name}",
  optionsValidator: (input) => ({ ok: true, value: input ?? {} }),
  factory: (options, context) => ({}),
};
`;
    writeFileSync(join(distDir, "index.js"), content);
  }
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverDescriptors", () => {
  test("returns empty array for empty directory", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const result = await discoverDescriptors(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("discovers channel-* package descriptors", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    createMockPackage(dir, "channel-slack", { kind: "channel", name: "slack" });
    createMockPackage(dir, "channel-discord", { kind: "channel", name: "discord" });

    const result = await discoverDescriptors(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      const names = result.value.map((d) => d.name).sort();
      expect(names).toEqual(["discord", "slack"]);
    }
  });

  test("discovers middleware-* package descriptors", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    createMockPackage(dir, "middleware-custom", { kind: "middleware", name: "custom" });

    const result = await discoverDescriptors(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("custom");
      expect(result.value[0]?.kind).toBe("middleware");
    }
  });

  test("skips packages in SKIP_LIST", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    createMockPackage(dir, "middleware-guardrails", { kind: "middleware", name: "guardrails" });
    createMockPackage(dir, "middleware-custom", { kind: "middleware", name: "custom" });

    const result = await discoverDescriptors(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("custom");
    }
  });

  test("handles missing dist/index.js gracefully", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    // Create package dir without dist/index.js
    mkdirSync(join(dir, "channel-broken"), { recursive: true });

    const result = await discoverDescriptors(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("handles modules without descriptor export gracefully", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const distDir = join(dir, "channel-nodesc", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.js"), "export const foo = 42;\n");

    const result = await discoverDescriptors(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("returns error when packages directory does not exist", async () => {
    const result = await discoverDescriptors("/nonexistent/path/to/packages");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("Failed to scan packages directory");
    }
  });
});
