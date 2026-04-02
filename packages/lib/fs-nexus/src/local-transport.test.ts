/**
 * Integration tests for local subprocess transport.
 *
 * Requires nexus-fs Python package installed.
 * Skipped when nexus-fs is not available.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalTransport } from "./local-transport.js";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import type { NexusTransport } from "./types.js";

// Check if nexus-fs is available
let nexusFsAvailable = false;
try {
  const proc = Bun.spawnSync(["python3", "-c", "import nexus.fs"]);
  nexusFsAvailable = proc.exitCode === 0;
} catch {
  nexusFsAvailable = false;
}

const describeIf = nexusFsAvailable ? describe : describe.skip;

describeIf("createLocalTransport (requires nexus-fs)", () => {
  let tmpDir: string;
  let transport: NexusTransport;
  /** Nexus mount point discovered from the bridge (e.g. "/local/koi-test-XXX"). */
  let mountPoint: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "koi-fs-nexus-test-"));
    transport = await createLocalTransport({
      mountUri: `local://${tmpDir}`,
      startupTimeoutMs: 15_000,
    });
    // Use mount point reported by the bridge — nexus-fs path derivation is complex
    const firstMount = transport.mounts?.[0];
    expect(firstMount).toBeDefined();
    mountPoint = firstMount ?? "";
  });

  afterEach(() => {
    transport.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  test("write and read round-trip", async () => {
    const writeResult = await transport.call<{ readonly bytes_written: number }>("write", {
      path: `${mountPoint}/hello.txt`,
      content: "hello from koi",
    });
    expect(writeResult.ok).toBe(true);

    const readResult = await transport.call<{ readonly content: string }>("read", {
      path: `${mountPoint}/hello.txt`,
    });
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("hello from koi");
    }
  });

  test("list files", async () => {
    await transport.call("write", { path: `${mountPoint}/a.txt`, content: "a" });
    await transport.call("write", { path: `${mountPoint}/b.txt`, content: "b" });

    const result = await transport.call<{
      readonly files: readonly { readonly path: string }[];
    }>("list", {
      path: mountPoint,
      details: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("read non-existent file returns NOT_FOUND", async () => {
    const result = await transport.call("read", {
      path: `${mountPoint}/does-not-exist.txt`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("full backend integration via createNexusFileSystem", async () => {
    // Strip leading "/" for mountPoint config (basePath convention)
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    const writeResult = await backend.write("/integration.txt", "test content");
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.read("/integration.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("test content");
    }
  });
});
