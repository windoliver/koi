import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileScopeRegistry,
  createInMemoryScopeRegistry,
  defaultScopeRegistryDir,
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

  test("forgetIfMatches removes only on id match", async () => {
    const reg = createInMemoryScopeRegistry();
    await reg.record("a", "id-1");
    expect(await reg.forgetIfMatches("a", "id-other")).toBe(false);
    expect(await reg.lookup("a")).toBe("id-1");
    expect(await reg.forgetIfMatches("a", "id-1")).toBe(true);
    expect(await reg.lookup("a")).toBeUndefined();
    expect(await reg.forgetIfMatches("a", "id-1")).toBe(false);
  });
});

describe("defaultScopeRegistryDir", () => {
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
    expect(defaultScopeRegistryDir()).toBe("/tmp/koi-state/scopes");
  });

  test("XDG_STATE_HOME used when override unset", () => {
    delete process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    expect(defaultScopeRegistryDir()).toBe("/tmp/xdg-state/koi-sandbox-docker/scopes");
  });

  test("falls back to ~/.local/state when neither set", () => {
    delete process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
    delete process.env.XDG_STATE_HOME;
    const p = defaultScopeRegistryDir();
    expect(p.endsWith("/.local/state/koi-sandbox-docker/scopes")).toBe(true);
  });
});

describe("createFileScopeRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-scope-reg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing dir ⇒ lookup returns undefined", async () => {
    const reg = createFileScopeRegistry({ dir: join(dir, "never-created") });
    expect(await reg.lookup("anything")).toBeUndefined();
  });

  test("record persists across registry instances", async () => {
    const reg = createFileScopeRegistry({ dir });
    await reg.record("scope-A", "container-A");
    expect(await reg.lookup("scope-A")).toBe("container-A");
    const reg2 = createFileScopeRegistry({ dir });
    expect(await reg2.lookup("scope-A")).toBe("container-A");
  });

  test("record overwrites prior entry for the same scope and sweeps stale", async () => {
    const reg = createFileScopeRegistry({ dir });
    await reg.record("scope-A", "old");
    await reg.record("scope-A", "new");
    expect(await reg.lookup("scope-A")).toBe("new");
    // Sweep guarantee: only one .scope file remains for scope-A.
    const files = readdirSync(dir).filter((n) => n.endsWith(".scope"));
    expect(files.length).toBe(1);
  });

  test("forget removes the entry; second forget is a no-op", async () => {
    const reg = createFileScopeRegistry({ dir });
    await reg.record("scope-A", "container-A");
    await reg.record("scope-B", "container-B");
    await reg.forget("scope-A");
    expect(await reg.lookup("scope-A")).toBeUndefined();
    expect(await reg.lookup("scope-B")).toBe("container-B");
    await reg.forget("scope-A");
    expect(await reg.lookup("scope-A")).toBeUndefined();
  });

  test("forget for an unknown scope is a no-op", async () => {
    const reg = createFileScopeRegistry({ dir });
    await reg.forget("never-recorded");
    expect(await reg.lookup("never-recorded")).toBeUndefined();
  });

  test("forgetIfMatches with mismatching id leaves the entry intact", async () => {
    // Critical CAS guarantee: a stale forgetIfMatches from one process must
    // NOT delete a fresh ownership record from another process.
    const reg = createFileScopeRegistry({ dir });
    await reg.record("scope-A", "fresh-id");
    expect(await reg.forgetIfMatches("scope-A", "stale-id")).toBe(false);
    expect(await reg.lookup("scope-A")).toBe("fresh-id");
  });

  test("forgetIfMatches with matching id removes the entry", async () => {
    const reg = createFileScopeRegistry({ dir });
    await reg.record("scope-A", "id-1");
    expect(await reg.forgetIfMatches("scope-A", "id-1")).toBe(true);
    expect(await reg.lookup("scope-A")).toBeUndefined();
  });

  test("forgetIfMatches on absent scope returns false", async () => {
    const reg = createFileScopeRegistry({ dir });
    expect(await reg.forgetIfMatches("never", "id")).toBe(false);
  });

  test("concurrent writes to DIFFERENT scopes never overwrite each other", async () => {
    const reg = createFileScopeRegistry({ dir });
    const scopes = Array.from({ length: 50 }, (_, i) => [`scope-${i}`, `container-${i}`] as const);
    await Promise.all(scopes.map(([s, c]) => reg.record(s, c)));
    for (const [s, c] of scopes) {
      expect(await reg.lookup(s)).toBe(c);
    }
    expect(readdirSync(dir).filter((n) => n.endsWith(".scope")).length).toBe(50);
  });

  test("uses defaultScopeRegistryDir when no dir provided", async () => {
    const stateDir = join(dir, "default-state");
    process.env.KOI_SANDBOX_DOCKER_STATE_DIR = stateDir;
    try {
      const reg = createFileScopeRegistry();
      await reg.record("scope-D", "container-D");
      expect(await reg.lookup("scope-D")).toBe("container-D");
    } finally {
      delete process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
    }
  });

  test("scope keys with filesystem-unsafe characters round-trip safely", async () => {
    const reg = createFileScopeRegistry({ dir });
    const tricky = "team/foo:bar..\\baz";
    await reg.record(tricky, "container-X");
    expect(await reg.lookup(tricky)).toBe("container-X");
  });
});
