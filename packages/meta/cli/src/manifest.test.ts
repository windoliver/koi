import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifestConfig } from "./manifest.js";

// Regression tests for #1777 — manifest.filesystem must be parsed,
// validated, and surfaced so `koi start --manifest` / `koi tui --manifest`
// can wire alternate filesystem backends instead of silently falling
// through to the default local backend.

describe("loadManifestConfig: filesystem block", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-1777-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits filesystem when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesystem).toBeUndefined();
  });

  test("parses filesystem.backend: local", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "filesystem:", "  backend: local"].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesystem).toEqual({ backend: "local" });
  });

  test("parses filesystem.backend: nexus with local bridge options", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        '    mountUri: "local://./workspace"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesystem).toEqual({
      backend: "nexus",
      options: {
        transport: "local",
        mountUri: "local://./workspace",
      },
    });
  });

  test("rejects invalid filesystem.backend enum", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: quantum-drive",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("filesystem");
    expect(result.error).toContain("backend");
  });

  test("rejects filesystem with unknown top-level key", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: local",
        "  unknownKey: 1",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("filesystem");
  });

  test("rejects filesystem that is not an object", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "filesystem: nope"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("filesystem");
  });
});
