/**
 * Tests for static descriptor discovery from pre-built manifests.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DescriptorManifest } from "./discover-static.js";
import { discoverDescriptorsAuto, discoverDescriptorsFromManifest } from "./discover-static.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `koi-discover-static-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

function createMockPackageWithDescriptor(
  packageDir: string,
  descriptor: {
    readonly kind: string;
    readonly name: string;
    readonly aliases?: readonly string[];
  },
): void {
  const distDir = join(packageDir, "dist");
  mkdirSync(distDir, { recursive: true });

  const aliasesStr =
    descriptor.aliases !== undefined
      ? `[${descriptor.aliases.map((a) => `"${a}"`).join(", ")}]`
      : "undefined";

  const content = `
export const descriptor = {
  kind: "${descriptor.kind}",
  name: "${descriptor.name}",
  aliases: ${aliasesStr},
  optionsValidator: (input) => ({ ok: true, value: input ?? {} }),
  factory: (options, context) => ({}),
};
`;
  writeFileSync(join(distDir, "index.js"), content);
}

function writeManifest(dir: string, manifest: DescriptorManifest): string {
  const manifestPath = join(dir, "descriptor-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
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
// discoverDescriptorsFromManifest
// ---------------------------------------------------------------------------

describe("discoverDescriptorsFromManifest", () => {
  test("returns NOT_FOUND when manifest file is missing", async () => {
    const result = await discoverDescriptorsFromManifest("/nonexistent/path/manifest.json");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("Descriptor manifest not found");
    }
  });

  test("returns VALIDATION error for malformed manifest", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ invalid: true }));

    const result = await discoverDescriptorsFromManifest(manifestPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("invalid format");
    }
  });

  test("loads descriptors from valid manifest with package paths", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    // Create mock packages
    const slackPkgDir = join(dir, "channel-slack");
    createMockPackageWithDescriptor(slackPkgDir, {
      kind: "channel",
      name: "slack",
      aliases: ["slackbot"],
    });

    const customPkgDir = join(dir, "middleware-custom");
    createMockPackageWithDescriptor(customPkgDir, {
      kind: "middleware",
      name: "custom",
    });

    // Write manifest pointing to those packages
    const manifest: DescriptorManifest = {
      descriptors: [
        {
          kind: "channel",
          name: "slack",
          aliases: ["slackbot"],
          packagePath: slackPkgDir,
        },
        {
          kind: "middleware",
          name: "custom",
          packagePath: customPkgDir,
        },
      ],
    };

    const manifestPath = writeManifest(dir, manifest);

    const result = await discoverDescriptorsFromManifest(manifestPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      const names = result.value.map((d) => d.name).sort();
      expect(names).toEqual(["custom", "slack"]);
    }
  });

  test("skips entries whose package cannot be imported", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    // Create one valid package
    const validPkgDir = join(dir, "channel-slack");
    createMockPackageWithDescriptor(validPkgDir, {
      kind: "channel",
      name: "slack",
    });

    // Manifest references a valid + a missing package
    const manifest: DescriptorManifest = {
      descriptors: [
        {
          kind: "channel",
          name: "slack",
          packagePath: validPkgDir,
        },
        {
          kind: "middleware",
          name: "missing",
          packagePath: join(dir, "nonexistent-package"),
        },
      ],
    };

    const manifestPath = writeManifest(dir, manifest);

    const result = await discoverDescriptorsFromManifest(manifestPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("slack");
    }
  });

  test("returns empty array for manifest with no entries", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const manifest: DescriptorManifest = { descriptors: [] };
    const manifestPath = writeManifest(dir, manifest);

    const result = await discoverDescriptorsFromManifest(manifestPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// discoverDescriptorsAuto
// ---------------------------------------------------------------------------

describe("discoverDescriptorsAuto", () => {
  test("uses manifest when available", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    // Create a mock package
    const pkgDir = join(dir, "engine-test");
    createMockPackageWithDescriptor(pkgDir, {
      kind: "engine",
      name: "test-engine",
    });

    // Write manifest
    const manifest: DescriptorManifest = {
      descriptors: [
        {
          kind: "engine",
          name: "test-engine",
          packagePath: pkgDir,
        },
      ],
    };

    const manifestPath = writeManifest(dir, manifest);

    // packagesDir is irrelevant when manifest is found
    const result = await discoverDescriptorsAuto("/irrelevant/path", manifestPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("test-engine");
    }
  });

  test("falls back to dynamic scanning when manifest is missing", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    // Create a discoverable package in the packages dir (no manifest)
    const pkgDir = join(dir, "channel-test");
    createMockPackageWithDescriptor(pkgDir, {
      kind: "channel",
      name: "test-channel",
    });

    const result = await discoverDescriptorsAuto(dir, join(dir, "nonexistent-manifest.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("test-channel");
    }
  });

  test("falls back to dynamic scanning for empty directory (no manifest)", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const result = await discoverDescriptorsAuto(dir, join(dir, "nonexistent-manifest.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});
