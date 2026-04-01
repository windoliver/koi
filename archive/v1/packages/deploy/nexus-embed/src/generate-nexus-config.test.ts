import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { derivePort, generateNexusConfig } from "./generate-nexus-config.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nexus-gen-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// derivePort
// ---------------------------------------------------------------------------

describe("derivePort", () => {
  test("returns a number in the ephemeral range", () => {
    const port = derivePort("/some/workspace");
    expect(port).toBeGreaterThanOrEqual(10000);
    expect(port).toBeLessThan(60000);
  });

  test("returns the same port for the same path", () => {
    const a = derivePort("/workspace/a");
    const b = derivePort("/workspace/a");
    expect(a).toBe(b);
  });

  test("returns different ports for different paths", () => {
    const a = derivePort("/workspace/a");
    const b = derivePort("/workspace/b");
    expect(a).not.toBe(b);
  });

  test("resolves relative paths to absolute before hashing", () => {
    const absolute = derivePort(resolve("./test-workspace"));
    const relative = derivePort("./test-workspace");
    expect(absolute).toBe(relative);
  });
});

// ---------------------------------------------------------------------------
// generateNexusConfig
// ---------------------------------------------------------------------------

describe("generateNexusConfig", () => {
  test("generates nexus.yaml with required fields", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir });

    const yamlPath = join(tempDir, "nexus.yaml");
    expect(existsSync(yamlPath)).toBe(true);

    const content = readFileSync(yamlPath, "utf-8");
    expect(content).toContain("preset: demo");
    expect(content).toContain(`data_dir: ${join(resolve(tempDir), "nexus-data")}`);
    expect(content).toContain("auth: database");
    expect(content).toContain("api_key: sk-");
    expect(content).toContain("compose_file:");
    expect(content).toContain("image_channel: edge");
  });

  test("generates nexus-stack.yml", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir });

    const composePath = join(tempDir, "nexus-stack.yml");
    expect(existsSync(composePath)).toBe(true);

    const content = readFileSync(composePath, "utf-8");
    expect(content).toContain("services:");
    expect(content).toContain("postgres:");
    expect(content).toContain("nexus:");
    expect(content).toContain("dragonfly:");
    expect(content).toContain("zoekt:");
  });

  test("generates pgvector init SQL", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir });

    const sqlPath = join(tempDir, "001-enable-pgvector.sql");
    expect(existsSync(sqlPath)).toBe(true);

    const content = readFileSync(sqlPath, "utf-8");
    expect(content).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  });

  test("creates nexus-data directory", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir });

    const dataDir = join(tempDir, "nexus-data");
    expect(existsSync(dataDir)).toBe(true);
  });

  test("uses custom port when provided", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir, port: 9999 });

    const content = readFileSync(join(tempDir, "nexus.yaml"), "utf-8");
    expect(content).toContain("http: 9999");
  });

  test("derives port from workspace path when no port specified", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir });

    const content = readFileSync(join(tempDir, "nexus.yaml"), "utf-8");
    const expected = derivePort(tempDir);
    expect(content).toContain(`http: ${String(expected)}`);
  });

  test("maps koi presets to nexus presets", () => {
    const presetTests = [
      { koi: "local", nexus: "local" },
      { koi: "demo", nexus: "demo" },
      { koi: "mesh", nexus: "shared" },
      { koi: "sqlite", nexus: "demo" },
    ] as const;

    for (const { koi, nexus } of presetTests) {
      const dir = mkdtempSync(join(tmpdir(), `nexus-preset-${koi}-`));
      try {
        generateNexusConfig({ koiPreset: koi, cwd: dir });
        const content = readFileSync(join(dir, "nexus.yaml"), "utf-8");
        expect(content).toContain(`preset: ${nexus}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("uses stable channel when specified", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir, channel: "stable" });

    const content = readFileSync(join(tempDir, "nexus.yaml"), "utf-8");
    expect(content).toContain("image_channel: stable");
    expect(content).toContain("ghcr.io/nexi-lab/nexus:stable");
  });

  test("generates unique API key each time", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "nexus-key-1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "nexus-key-2-"));
    try {
      generateNexusConfig({ koiPreset: "demo", cwd: dir1 });
      generateNexusConfig({ koiPreset: "demo", cwd: dir2 });

      const content1 = readFileSync(join(dir1, "nexus.yaml"), "utf-8");
      const content2 = readFileSync(join(dir2, "nexus.yaml"), "utf-8");

      const key1 = /^api_key:\s*(.+)$/m.exec(content1)?.[1];
      const key2 = /^api_key:\s*(.+)$/m.exec(content2)?.[1];

      expect(key1).toBeDefined();
      expect(key2).toBeDefined();
      expect(key1).not.toBe(key2);
      expect(key1).toMatch(/^sk-/);
      expect(key2).toMatch(/^sk-/);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("sets grpc port to http + 2", () => {
    generateNexusConfig({ koiPreset: "demo", cwd: tempDir, port: 10000 });

    const content = readFileSync(join(tempDir, "nexus.yaml"), "utf-8");
    expect(content).toContain("grpc: 10002");
  });
});
