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
    writeJson(koiDir, "settings.json", { theme: "dark" });
    const result = await loadSettings({
      cwd: join(tmpDir, "project"),
      homeDir: tmpDir,
      layers: ["user"],
    });
    expect(result.settings.theme).toBe("dark");
    expect(result.errors).toHaveLength(0);
  });

  test("project overrides user (scalar last-wins)", async () => {
    const homeKoi = join(tmpDir, ".koi");
    const projKoi = join(tmpDir, "project", ".koi");
    writeJson(homeKoi, "settings.json", { theme: "dark" });
    writeJson(projKoi, "settings.json", { theme: "light" });
    const result = await loadSettings({
      cwd: join(tmpDir, "project"),
      homeDir: tmpDir,
      layers: ["user", "project"],
    });
    expect(result.settings.theme).toBe("light");
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
    writeJson(koiDir, "settings.json", { theme: "neon" });
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
    writeFileSync(flagPath, JSON.stringify({ theme: "light" }));
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: tmpDir,
      flagPath,
      layers: ["flag"],
    });
    expect(result.settings.theme).toBe("light");
  });

  test("sources record contains per-layer snapshots", async () => {
    const koiDir = join(tmpDir, ".koi");
    writeJson(koiDir, "settings.json", { theme: "dark" });
    const result = await loadSettings({
      cwd: tmpDir,
      homeDir: tmpDir,
      layers: ["project"],
    });
    expect(result.sources.project).toEqual({ theme: "dark" });
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
    writeFileSync(policyPath, JSON.stringify({ theme: "neon" })); // invalid enum value
    await expect(
      loadSettings({
        cwd: tmpDir,
        homeDir: tmpDir,
        layers: ["policy"],
        policyPath,
      }),
    ).rejects.toThrow();
  });
});
