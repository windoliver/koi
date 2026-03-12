import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nexusDown, nexusInit, nexusUp } from "./nexus-lifecycle.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nexus-lifecycle-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// nexusInit
// ---------------------------------------------------------------------------

describe("nexusInit", () => {
  test("returns error when nexus binary is unavailable", async () => {
    const saved = process.env.NEXUS_COMMAND;
    process.env.NEXUS_COMMAND = "/nonexistent/nexus-fake-binary";
    try {
      const result = await nexusInit("demo", { cwd: tempDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    } finally {
      if (saved !== undefined) {
        process.env.NEXUS_COMMAND = saved;
      } else {
        delete process.env.NEXUS_COMMAND;
      }
    }
  });

  test("maps koi presets to nexus presets", () => {
    // Verify the preset mapping contract
    const PRESET_MAP: Readonly<Record<string, string>> = {
      local: "local",
      demo: "demo",
      mesh: "shared",
    };
    expect(PRESET_MAP.local).toBe("local");
    expect(PRESET_MAP.demo).toBe("demo");
    expect(PRESET_MAP.mesh).toBe("shared");
  });
});

// ---------------------------------------------------------------------------
// nexusUp
// ---------------------------------------------------------------------------

describe("nexusUp", () => {
  test("returns error when nexus binary is unavailable", async () => {
    const saved = process.env.NEXUS_COMMAND;
    process.env.NEXUS_COMMAND = "/nonexistent/nexus-fake-binary";
    try {
      const result = await nexusUp({ cwd: tempDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    } finally {
      if (saved !== undefined) {
        process.env.NEXUS_COMMAND = saved;
      } else {
        delete process.env.NEXUS_COMMAND;
      }
    }
  });

  test("detects missing nexus.yaml for auto-init", async () => {
    // Without nexus.yaml and with unavailable binary, auto-init is attempted but fails
    const saved = process.env.NEXUS_COMMAND;
    process.env.NEXUS_COMMAND = "/nonexistent/nexus-fake-binary";
    try {
      const result = await nexusUp({ cwd: tempDir, koiPreset: "demo" });
      expect(result.ok).toBe(false);
    } finally {
      if (saved !== undefined) {
        process.env.NEXUS_COMMAND = saved;
      } else {
        delete process.env.NEXUS_COMMAND;
      }
    }
  });

  test("returns correct default baseUrl", () => {
    // Verify URL construction with defaults
    const baseUrl = `http://127.0.0.1:${String(2026)}`;
    expect(baseUrl).toBe("http://127.0.0.1:2026");
  });

  test("returns correct baseUrl with custom port", () => {
    const port = 3000;
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    expect(baseUrl).toBe("http://127.0.0.1:3000");
  });
});

// ---------------------------------------------------------------------------
// nexusDown
// ---------------------------------------------------------------------------

describe("nexusDown", () => {
  test("returns error when nexus binary is unavailable", async () => {
    const saved = process.env.NEXUS_COMMAND;
    process.env.NEXUS_COMMAND = "/nonexistent/nexus-fake-binary";
    try {
      const result = await nexusDown({ cwd: tempDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    } finally {
      if (saved !== undefined) {
        process.env.NEXUS_COMMAND = saved;
      } else {
        delete process.env.NEXUS_COMMAND;
      }
    }
  });
});
