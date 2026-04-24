// packages/lib/settings/src/loader.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "./loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "koi-settings-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe("loadSettings", () => {
  test("returns empty settings when no files exist", async () => {
    const result = await loadSettings({ cwd: tmpDir, homeDir: tmpDir });
    expect(result.settings).toEqual({});
    expect(result.errors).toHaveLength(0);
  });

  test("loads a single user settings file", async () => {
    const koiDir = join(tmpDir, ".koi");
    writeJson(koiDir, "settings.json", { permissions: { defaultMode: "default" } });
    const result = await loadSettings({
      cwd: join(tmpDir, "project"),
      homeDir: tmpDir,
      layers: ["user"],
    });
    expect(result.settings.permissions?.defaultMode).toBe("default");
    expect(result.errors).toHaveLength(0);
  });

  test("project overrides user (scalar last-wins)", async () => {
    const homeKoi = join(tmpDir, ".koi");
    const projKoi = join(tmpDir, "project", ".koi");
    writeJson(homeKoi, "settings.json", { permissions: { allow: ["fs_read(*)"] } });
    writeJson(projKoi, "settings.json", { permissions: { defaultMode: "default" } });
    const result = await loadSettings({
      cwd: join(tmpDir, "project"),
      homeDir: tmpDir,
      layers: ["user", "project"],
    });
    expect(result.settings.permissions?.defaultMode).toBe("default");
  });

  test("allow arrays are concatenated across layers", async () => {
    const homeKoi = join(tmpDir, ".koi");
    const projKoi = join(tmpDir, "project", ".koi");
    writeJson(homeKoi, "settings.json", { permissions: { allow: ["Read(*)"] } });
    writeJson(projKoi, "settings.json", { permissions: { allow: ["Bash(git *)"] } });
    const result = await loadSettings({
      cwd: join(tmpDir, "project"),
      homeDir: tmpDir,
      layers: ["user", "project"],
    });
    expect(result.settings.permissions?.allow).toEqual(
      expect.arrayContaining(["Read(*)", "Bash(git *)"]),
    );
    expect(result.settings.permissions?.allow).toHaveLength(2);
  });

  test("malformed JSON in non-policy layer is skipped with ValidationError", async () => {
    const koiDir = join(tmpDir, ".koi");
    mkdirSync(koiDir, { recursive: true });
    writeFileSync(join(koiDir, "settings.json"), "{ bad json }");
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: tmpDir,
      layers: ["project"],
    });
    expect(result.settings).toEqual({});
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.file).toMatch(/settings\.json$/);
    expect(result.errors[0]?.message).toMatch(/Invalid JSON/);
  });

  test("schema-invalid field in non-policy layer is skipped with ValidationError", async () => {
    const koiDir = join(tmpDir, ".koi");
    writeJson(koiDir, "settings.json", { permissions: { defaultMode: "invalid_mode" } });
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: tmpDir,
      layers: ["project"],
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("missing file is silently skipped (no error)", async () => {
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: tmpDir,
      layers: ["user"],
    });
    expect(result.settings).toEqual({});
    expect(result.errors).toHaveLength(0);
  });

  test("flag layer uses provided flagPath", async () => {
    const flagPath = join(tmpDir, "custom.json");
    writeFileSync(flagPath, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }));
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: tmpDir,
      flagPath,
      layers: ["flag"],
    });
    expect(result.settings.permissions?.deny).toEqual(["Bash(rm *)"]);
  });

  test("flag layer failure is fatal when flagPath explicitly provided", async () => {
    const flagPath = join(tmpDir, "nonexistent.json");
    await expect(
      loadSettings({
        cwd: tmpDir,
        homeDir: tmpDir,
        flagPath,
        layers: ["flag"],
      }),
    ).rejects.toThrow(/not found/);
  });

  test("empty policy file throws (fail-closed)", async () => {
    const policyPath = join(tmpDir, "policy.json");
    writeFileSync(policyPath, "   ");
    await expect(
      loadSettings({
        cwd: tmpDir,
        homeDir: tmpDir,
        layers: ["policy"],
        policyPath,
      }),
    ).rejects.toThrow(/empty/);
  });

  test("sources record contains per-layer snapshots", async () => {
    const koiDir = join(tmpDir, ".koi");
    writeJson(koiDir, "settings.json", { permissions: { defaultMode: "default" } });
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: tmpDir,
      layers: ["project"],
    });
    expect(result.sources.project).toEqual({ permissions: { defaultMode: "default" } });
    expect(result.sources.user).toBeNull();
  });

  test("policy parse error throws (fail-closed)", async () => {
    const policyPath = join(tmpDir, "policy.json");
    writeFileSync(policyPath, "{ bad json }");
    await expect(
      loadSettings({
        cwd: tmpDir,
        homeDir: tmpDir,
        layers: ["policy"],
        policyPath,
      }),
    ).rejects.toThrow();
  });

  test("policy schema-invalid file throws (fail-closed)", async () => {
    const policyPath = join(tmpDir, "policy-schema.json");
    writeFileSync(policyPath, JSON.stringify({ permissions: { defaultMode: "plan" } }));
    await expect(
      loadSettings({
        cwd: tmpDir,
        homeDir: tmpDir,
        layers: ["policy"],
        policyPath,
      }),
    ).rejects.toThrow();
  });

  test("policy unknown key rejected (strict mode prevents false enforcement)", async () => {
    const policyPath = join(tmpDir, "policy-unknown.json");
    writeFileSync(policyPath, JSON.stringify({ disabledMcpServers: ["risky-server"] }));
    await expect(
      loadSettings({
        cwd: tmpDir,
        homeDir: tmpDir,
        layers: ["policy"],
        policyPath,
      }),
    ).rejects.toThrow();
  });

  test("full 5-layer stack: user+project+local+flag+policy all active", async () => {
    const homeKoi = join(tmpDir, ".koi");
    const projKoi = join(tmpDir, "project", ".koi");
    const flagPath = join(tmpDir, "flag.json");
    const policyPath = join(tmpDir, "policy.json");
    // user: allow Read
    writeJson(homeKoi, "settings.json", { permissions: { allow: ["Read(*)"] } });
    // project: allow Bash git, deny Bash rm
    writeJson(projKoi, "settings.json", {
      permissions: { allow: ["Bash(git *)"], deny: ["Bash(rm *)"] },
    });
    // local: deny Glob
    writeJson(projKoi, "settings.local.json", { permissions: { deny: ["Glob"] } });
    // flag: allow WebFetch
    writeFileSync(flagPath, JSON.stringify({ permissions: { allow: ["web_fetch(*)"] } }));
    // policy: deny WebFetch (tightens flag allow)
    writeFileSync(policyPath, JSON.stringify({ permissions: { deny: ["web_fetch(*)"] } }));

    const result = await loadSettings({
      cwd: join(tmpDir, "project"),
      homeDir: tmpDir,
      flagPath,
      policyPath,
      layers: ["user", "project", "local", "flag", "policy"],
    });

    expect(result.errors).toHaveLength(0);
    // policy tightening removes web_fetch(*) from allow — only user+project entries survive
    expect(result.settings.permissions?.allow).toEqual(
      expect.arrayContaining(["Read(*)", "Bash(git *)"]),
    );
    expect(result.settings.permissions?.allow).not.toContain("web_fetch(*)");
    // deny: project + local merged, then policy appends its own deny
    expect(result.settings.permissions?.deny).toEqual(
      expect.arrayContaining(["Bash(rm *)", "Glob", "web_fetch(*)"]),
    );
    // all layers captured in sources
    expect(result.sources.user).not.toBeNull();
    expect(result.sources.project).not.toBeNull();
    expect(result.sources.local).not.toBeNull();
    expect(result.sources.flag).not.toBeNull();
    expect(result.sources.policy).not.toBeNull();
  });

  test("policy subsumption removes matching entries from loaded allow list", async () => {
    const projKoi = join(tmpDir, ".koi");
    const policyPath = join(tmpDir, "policy.json");
    writeJson(projKoi, "settings.json", { permissions: { allow: ["Bash(git log*)", "Read(*)"] } });
    writeFileSync(policyPath, JSON.stringify({ permissions: { deny: ["Bash(*)"] } }));

    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: join(tmpDir, "nohome"),
      policyPath,
      layers: ["project", "policy"],
    });

    expect(result.errors).toHaveLength(0);
    // Bash(git log*) removed because policy denies Bash(*)
    expect(result.settings.permissions?.allow).not.toContain("Bash(git log*)");
    // Read(*) unaffected
    expect(result.settings.permissions?.allow).toContain("Read(*)");
    // policy deny is in result
    expect(result.settings.permissions?.deny).toContain("Bash(*)");
  });

  test("findProjectRoot falls back to cwd at filesystem root (no infinite loop)", async () => {
    // Pass cwd="/" — no .git or .koi anywhere above root; should return without throwing
    const result = await loadSettings({
      cwd: "/",
      homeDir: join(tmpDir, "nohome"),
      layers: ["project"],
    });
    // Will resolve to "/" as project root, no .koi/settings.json there → empty settings
    expect(result.settings).toEqual({});
    expect(result.errors).toHaveLength(0);
  });

  test("UTF-8 BOM in non-policy settings file → ValidationError (not throw)", async () => {
    const koiDir = join(tmpDir, ".koi");
    mkdirSync(koiDir, { recursive: true });
    // BOM-prefixed JSON — JSON.parse rejects it
    writeFileSync(join(koiDir, "settings.json"), "﻿" + JSON.stringify({ permissions: {} }));
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: join(tmpDir, "nohome"),
      layers: ["project"],
    });
    // Should produce an error, not throw
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.settings).toEqual({});
  });

  test("large allow array (1000 entries) deduplicates without OOM", async () => {
    const koiDir = join(tmpDir, ".koi");
    // 1000 unique allow entries in user layer
    const userEntries = Array.from({ length: 1000 }, (_, i) => `Tool${i}(*)`);
    writeJson(koiDir, "settings.json", { permissions: { allow: userEntries } });
    // 500 duplicates + 500 new entries in project layer
    const projKoi = join(tmpDir, "project", ".koi");
    const projEntries = [
      ...userEntries.slice(0, 500),
      ...Array.from({ length: 500 }, (_, i) => `Extra${i}(*)`),
    ];
    writeJson(projKoi, "settings.json", { permissions: { allow: projEntries } });

    const start = Date.now();
    const result = await loadSettings({
      cwd: join(tmpDir, "project"),
      homeDir: tmpDir,
      layers: ["user", "project"],
    });
    const elapsed = Date.now() - start;

    // Dedup: 1000 original + 500 new extras = 1500 unique
    expect(result.settings.permissions?.allow).toHaveLength(1500);
    // Must complete in <1s
    expect(elapsed).toBeLessThan(1000);
  });

  test("concurrent loadSettings calls return consistent independent results", async () => {
    const koiDir = join(tmpDir, ".koi");
    writeJson(koiDir, "settings.json", { permissions: { allow: ["Read(*)"] } });

    const [a, b, c] = await Promise.all([
      loadSettings({ cwd: tmpDir, homeDir: tmpDir, layers: ["project"] }),
      loadSettings({ cwd: tmpDir, homeDir: tmpDir, layers: ["project"] }),
      loadSettings({ cwd: tmpDir, homeDir: tmpDir, layers: ["project"] }),
    ]);

    expect(a.settings).toEqual(b.settings);
    expect(b.settings).toEqual(c.settings);
    expect(a.errors).toHaveLength(0);
  });

  test("nested empty .koi/ does not shadow parent project settings", async () => {
    // Parent project has a settings file
    const parentKoi = join(tmpDir, ".koi");
    writeJson(parentKoi, "settings.json", { permissions: { deny: ["Bash(rm *)"] } });
    // A subdirectory has an empty .koi/ (no settings files inside)
    const subdir = join(tmpDir, "src", "components");
    const subdirKoi = join(subdir, ".koi");
    mkdirSync(subdirKoi, { recursive: true });
    // Load from subdirectory — should find parent settings, not stop at empty .koi/
    const result = await loadSettings({
      cwd: subdir,
      homeDir: join(tmpDir, "nohome"),
      layers: ["project"],
    });
    expect(result.settings.permissions?.deny).toContain("Bash(rm *)");
  });
});
