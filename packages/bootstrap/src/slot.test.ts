import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSlot } from "./slot.js";
import type { BootstrapSlot } from "./types.js";

const SLOT: BootstrapSlot = {
  fileName: "INSTRUCTIONS.md",
  label: "Agent Instructions",
  budget: 8_000,
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "koi-slot-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Helper: write a file into the temp .koi/ hierarchy. */
async function writeKoiFile(relativePath: string, content: string): Promise<void> {
  const fullPath = join(tempDir, ".koi", relativePath);
  await Bun.write(fullPath, content);
}

describe("resolveSlot", () => {
  test("returns undefined when file does not exist", async () => {
    const result = await resolveSlot(SLOT, tempDir, undefined);
    expect(result).toBeUndefined();
  });

  test("reads from agent path when both exist", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "project-level");
    await writeKoiFile("agents/test-agent/INSTRUCTIONS.md", "agent-level");

    const result = await resolveSlot(SLOT, tempDir, "test-agent");
    expect(result).toBeDefined();
    expect(result?.content).toBe("agent-level");
    expect(result?.resolvedFrom).toBe(
      join(tempDir, ".koi", "agents", "test-agent", "INSTRUCTIONS.md"),
    );
  });

  test("reads from project path when agent path missing", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "project-level");

    const result = await resolveSlot(SLOT, tempDir, "test-agent");
    expect(result).toBeDefined();
    expect(result?.content).toBe("project-level");
    expect(result?.resolvedFrom).toBe(join(tempDir, ".koi", "INSTRUCTIONS.md"));
  });

  test("truncates content to budget characters", async () => {
    const longContent = "x".repeat(100);
    const smallSlot: BootstrapSlot = { fileName: "INSTRUCTIONS.md", label: "Test", budget: 50 };
    await writeKoiFile("INSTRUCTIONS.md", longContent);

    const result = await resolveSlot(smallSlot, tempDir, undefined);
    expect(result).toBeDefined();
    expect(result?.content.length).toBe(50);
    expect(result?.truncated).toBe(true);
  });

  test("includes contentHash in result (FNV-1a)", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "hello world");

    const result = await resolveSlot(SLOT, tempDir, undefined);
    expect(result).toBeDefined();
    expect(typeof result?.contentHash).toBe("number");
    expect(result?.contentHash).toBeGreaterThan(0);
  });

  test("sets truncated flag to false when content fits budget", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "short");

    const result = await resolveSlot(SLOT, tempDir, undefined);
    expect(result).toBeDefined();
    expect(result?.truncated).toBe(false);
  });

  test("reports original file size in bytes", async () => {
    const content = "hello world";
    await writeKoiFile("INSTRUCTIONS.md", content);

    const result = await resolveSlot(SLOT, tempDir, undefined);
    expect(result).toBeDefined();
    expect(result?.originalSize).toBe(Buffer.byteLength(content, "utf-8"));
  });

  test("rejects agent name with path traversal", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "should not be reachable");

    const result = await resolveSlot(SLOT, tempDir, "../../../etc");
    expect(result).toBeUndefined();
  });

  test("rejects fileName with path traversal", async () => {
    const maliciousSlot: BootstrapSlot = {
      fileName: "../../../etc/passwd",
      label: "Malicious",
      budget: 8_000,
    };

    const result = await resolveSlot(maliciousSlot, tempDir, undefined);
    expect(result).toBeUndefined();
  });

  test("truncates multi-byte content by characters not bytes", async () => {
    // Each CJK character is 3 bytes in UTF-8
    const cjkContent = "\u4F60\u597D\u4E16\u754C\u6D4B\u8BD5"; // 6 chars, 18 bytes
    const smallSlot: BootstrapSlot = { fileName: "INSTRUCTIONS.md", label: "Test", budget: 4 };
    await writeKoiFile("INSTRUCTIONS.md", cjkContent);

    const result = await resolveSlot(smallSlot, tempDir, undefined);
    expect(result).toBeDefined();
    expect(result?.content.length).toBe(4);
    expect(result?.content).toBe("\u4F60\u597D\u4E16\u754C");
    expect(result?.truncated).toBe(true);
  });
});
