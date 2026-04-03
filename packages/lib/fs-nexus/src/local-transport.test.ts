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

  test("full backend: write → read round-trip", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    const writeResult = await backend.write("/e2e-test.txt", "hello nexus-fs");
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.read("/e2e-test.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("hello nexus-fs");
      expect(readResult.value.path).toBe("/e2e-test.txt");
      expect(readResult.value.size).toBeGreaterThan(0);
    }
  });

  test("full backend: edit with native Nexus edit RPC", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-edit.txt", "hello world");
    const editResult = await backend.edit("/e2e-edit.txt", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(editResult.ok).toBe(true);
    if (editResult.ok) expect(editResult.value.hunksApplied).toBe(1);

    const readResult = await backend.read("/e2e-edit.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value.content).toBe("goodbye world");
  });

  test("full backend: list files", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-list/a.txt", "aaa");
    await backend.write("/e2e-list/b.txt", "bbb");
    const listResult = await backend.list("/e2e-list", { recursive: true });
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const paths = listResult.value.entries.map((e) => e.path);
      expect(paths.some((p) => p.includes("a.txt"))).toBe(true);
      expect(paths.some((p) => p.includes("b.txt"))).toBe(true);
    }
  });

  test("full backend: search via client-side fallback", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-search/target.txt", "findme in this line\nother line");
    const searchResult = await backend.search("findme");
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value.matches.length).toBeGreaterThanOrEqual(1);
      expect(searchResult.value.matches[0]?.text).toContain("findme");
    }
  });

  test("full backend: delete file", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-delete.txt", "bye");
    const del = backend.delete;
    expect(del).toBeDefined();
    if (del === undefined) return;

    const delResult = await del("/e2e-delete.txt");
    expect(delResult.ok).toBe(true);

    const readResult = await backend.read("/e2e-delete.txt");
    expect(readResult.ok).toBe(false);
  });

  test("full backend: rename file", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-rename-src.txt", "content");
    const rename = backend.rename;
    expect(rename).toBeDefined();
    if (rename === undefined) return;

    const renameResult = await rename("/e2e-rename-src.txt", "/e2e-rename-dst.txt");
    expect(renameResult.ok).toBe(true);

    const readResult = await backend.read("/e2e-rename-dst.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value.content).toBe("content");
  });

  test("full backend: edit dryRun does not modify file", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-dryrun.txt", "original content");
    const editResult = await backend.edit(
      "/e2e-dryrun.txt",
      [{ oldText: "original", newText: "modified" }],
      { dryRun: true },
    );
    expect(editResult.ok).toBe(true);
    if (editResult.ok) expect(editResult.value.hunksApplied).toBe(1);

    // File should be unchanged
    const readResult = await backend.read("/e2e-dryrun.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value.content).toBe("original content");
  });
});

describeIf("createLocalTransport multi-mount (requires nexus-fs)", () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let transport: NexusTransport;

  beforeEach(async () => {
    tmpDirA = mkdtempSync(join(tmpdir(), "koi-multi-a-"));
    tmpDirB = mkdtempSync(join(tmpdir(), "koi-multi-b-"));
    transport = await createLocalTransport({
      mountUri: [`local://${tmpDirA}`, `local://${tmpDirB}`],
      startupTimeoutMs: 15_000,
    });
  });

  afterEach(() => {
    transport.close();
    try {
      rmSync(tmpDirA, { recursive: true, force: true });
      rmSync(tmpDirB, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  test("reports multiple mount points", () => {
    expect(transport.mounts).toBeDefined();
    expect(transport.mounts?.length).toBe(2);
  });

  test("write/read to different mounts", async () => {
    const mounts = transport.mounts ?? [];
    expect(mounts.length).toBe(2);
    const mountA = mounts[0] ?? "";
    const mountB = mounts[1] ?? "";

    // Write to mount A
    const writeA = await transport.call("write", {
      path: `${mountA}/fileA.txt`,
      content: "from mount A",
    });
    expect(writeA.ok).toBe(true);

    // Write to mount B
    const writeB = await transport.call("write", {
      path: `${mountB}/fileB.txt`,
      content: "from mount B",
    });
    expect(writeB.ok).toBe(true);

    // Read back from each — files are isolated
    const readA = await transport.call<{ readonly content: string }>("read", {
      path: `${mountA}/fileA.txt`,
    });
    expect(readA.ok).toBe(true);
    if (readA.ok) expect(readA.value.content).toBe("from mount A");

    const readB = await transport.call<{ readonly content: string }>("read", {
      path: `${mountB}/fileB.txt`,
    });
    expect(readB.ok).toBe(true);
    if (readB.ok) expect(readB.value.content).toBe("from mount B");

    // Mount A should NOT have mount B's file
    const crossRead = await transport.call("read", {
      path: `${mountA}/fileB.txt`,
    });
    expect(crossRead.ok).toBe(false);
  });
});
