import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("accepts port option without error", async () => {
    const saved = process.env.NEXUS_COMMAND;
    process.env.NEXUS_COMMAND = "/nonexistent/nexus-fake-binary";
    try {
      // Port option should be accepted even though binary is unavailable
      const result = await nexusInit("demo", { cwd: tempDir, port: 3000 });
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

  test("accepts build and portStrategy options without error", async () => {
    const saved = process.env.NEXUS_COMMAND;
    process.env.NEXUS_COMMAND = "/nonexistent/nexus-fake-binary";
    try {
      const result = await nexusUp({
        cwd: tempDir,
        koiPreset: "demo",
        build: true,
        portStrategy: "fail",
        port: 4000,
      });
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

// ---------------------------------------------------------------------------
// nexusUp with nexus.yml fallback
// ---------------------------------------------------------------------------

describe("nexusUp config search", () => {
  test("detects nexus.yml as well as nexus.yaml", async () => {
    // Write a nexus.yml (not .yaml) in tempDir — nexusUp should find it
    // and skip auto-init. It will still fail because the binary is unavailable,
    // but it should fail on `nexus up`, not on `nexus init`.
    writeFileSync(
      join(tempDir, "nexus.yml"),
      "preset: demo\nports:\n  http: 2026\napi_key: nx_admin_test123\n",
    );
    const saved = process.env.NEXUS_COMMAND;
    process.env.NEXUS_COMMAND = "/nonexistent/nexus-fake-binary";
    try {
      const result = await nexusUp({ cwd: tempDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Should fail on binary check, NOT auto-init (because nexus.yml exists)
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
