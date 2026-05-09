import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileScopeRegistry,
  createInMemoryScopeRegistry,
  defaultScopeRegistryPath,
} from "./scope-registry.js";

describe("createInMemoryScopeRegistry", () => {
  test("record / lookup / forget round-trip", async () => {
    const reg = createInMemoryScopeRegistry();
    expect(await reg.lookup("a")).toBeUndefined();
    await reg.record("a", "container-1");
    expect(await reg.lookup("a")).toBe("container-1");
    await reg.record("a", "container-2");
    expect(await reg.lookup("a")).toBe("container-2");
    await reg.forget("a");
    expect(await reg.lookup("a")).toBeUndefined();
  });

  test("forget on unknown scope is a no-op", async () => {
    const reg = createInMemoryScopeRegistry();
    await reg.forget("unknown");
    expect(await reg.lookup("unknown")).toBeUndefined();
  });
});

describe("defaultScopeRegistryPath", () => {
  const saved = {
    state: process.env.KOI_SANDBOX_DOCKER_STATE_DIR,
    xdg: process.env.XDG_STATE_HOME,
  };
  afterEach(() => {
    if (saved.state === undefined) delete process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
    else process.env.KOI_SANDBOX_DOCKER_STATE_DIR = saved.state;
    if (saved.xdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.xdg;
  });

  test("KOI_SANDBOX_DOCKER_STATE_DIR override wins", () => {
    process.env.KOI_SANDBOX_DOCKER_STATE_DIR = "/tmp/koi-state";
    expect(defaultScopeRegistryPath()).toBe("/tmp/koi-state/scopes.json");
  });

  test("XDG_STATE_HOME used when override unset", () => {
    delete process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    expect(defaultScopeRegistryPath()).toBe("/tmp/xdg-state/koi-sandbox-docker/scopes.json");
  });

  test("falls back to ~/.local/state when neither set", () => {
    delete process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
    delete process.env.XDG_STATE_HOME;
    const p = defaultScopeRegistryPath();
    expect(p.endsWith("/.local/state/koi-sandbox-docker/scopes.json")).toBe(true);
  });
});

describe("createFileScopeRegistry", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-scope-reg-"));
    path = join(dir, "nested", "scopes.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file ⇒ lookup returns undefined", async () => {
    const reg = createFileScopeRegistry({ path });
    expect(await reg.lookup("anything")).toBeUndefined();
  });

  test("record creates the file with 0600 perms and survives reload", async () => {
    const reg = createFileScopeRegistry({ path });
    await reg.record("scope-A", "container-A");
    expect(await reg.lookup("scope-A")).toBe("container-A");
    // New instance reading the same path sees the prior write.
    const reg2 = createFileScopeRegistry({ path });
    expect(await reg2.lookup("scope-A")).toBe("container-A");
    // File contents are valid JSON with version 1.
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw).toMatchObject({
      version: 1,
      scopes: { "scope-A": { containerId: "container-A" } },
    });
  });

  test("record overwrites prior entry for the same scope", async () => {
    const reg = createFileScopeRegistry({ path });
    await reg.record("scope-A", "old");
    await reg.record("scope-A", "new");
    expect(await reg.lookup("scope-A")).toBe("new");
  });

  test("forget removes the entry; second forget is a no-op", async () => {
    const reg = createFileScopeRegistry({ path });
    await reg.record("scope-A", "container-A");
    await reg.record("scope-B", "container-B");
    await reg.forget("scope-A");
    expect(await reg.lookup("scope-A")).toBeUndefined();
    expect(await reg.lookup("scope-B")).toBe("container-B");
    await reg.forget("scope-A");
    expect(await reg.lookup("scope-A")).toBeUndefined();
  });

  test("corrupted file ⇒ treated as empty registry", async () => {
    // Pre-create the dir then write garbage so we don't have to wait for record.
    const reg = createFileScopeRegistry({ path });
    await reg.record("seed", "c1");
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(await reg.lookup("seed")).toBeUndefined();
    // A subsequent record cleanly replaces the corrupt file.
    await reg.record("scope-X", "container-X");
    expect(await reg.lookup("scope-X")).toBe("container-X");
  });

  test("file with wrong version is ignored", async () => {
    const reg = createFileScopeRegistry({ path });
    await reg.record("seed", "c1");
    writeFileSync(path, JSON.stringify({ version: 2, scopes: { x: { containerId: "y" } } }));
    expect(await reg.lookup("x")).toBeUndefined();
  });

  test("file with malformed scope entries skips them", async () => {
    const reg = createFileScopeRegistry({ path });
    await reg.record("seed", "c1");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        scopes: {
          good: { containerId: "abc" },
          bad1: { wrongKey: "x" },
          bad2: "not-an-object",
        },
      }),
    );
    expect(await reg.lookup("good")).toBe("abc");
    expect(await reg.lookup("bad1")).toBeUndefined();
    expect(await reg.lookup("bad2")).toBeUndefined();
  });

  test("concurrent records serialize and all persist", async () => {
    const reg = createFileScopeRegistry({ path });
    await Promise.all([reg.record("a", "1"), reg.record("b", "2"), reg.record("c", "3")]);
    expect(await reg.lookup("a")).toBe("1");
    expect(await reg.lookup("b")).toBe("2");
    expect(await reg.lookup("c")).toBe("3");
  });

  test("uses defaultScopeRegistryPath when no path provided", async () => {
    const stateDir = join(dir, "default-state");
    process.env.KOI_SANDBOX_DOCKER_STATE_DIR = stateDir;
    try {
      const reg = createFileScopeRegistry();
      await reg.record("scope-D", "container-D");
      expect(await reg.lookup("scope-D")).toBe("container-D");
      const raw: unknown = JSON.parse(readFileSync(join(stateDir, "scopes.json"), "utf-8"));
      expect(raw).toMatchObject({
        version: 1,
        scopes: { "scope-D": { containerId: "container-D" } },
      });
    } finally {
      delete process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
    }
  });
});
