import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SLOTS, resolveBootstrap } from "./resolve.js";
import type { BootstrapSlot } from "./types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "koi-bootstrap-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Helper: write a file into the temp .koi/ hierarchy. */
async function writeKoiFile(relativePath: string, content: string): Promise<void> {
  const fullPath = join(tempDir, ".koi", relativePath);
  await Bun.write(fullPath, content);
}

describe("resolveBootstrap", () => {
  test("returns ok with empty sources when .koi/ dir does not exist", async () => {
    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toEqual([]);
    expect(result.value.resolved).toEqual([]);
    expect(result.value.warnings).toEqual([]);
  });

  test("resolves project-level INSTRUCTIONS.md", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "You are a helpful agent.");

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]?.text).toBe("You are a helpful agent.");
    expect(result.value.sources[0]?.kind).toBe("text");
    expect(result.value.sources[0]?.label).toBe("Agent Instructions");
  });

  test("resolves project-level TOOLS.md", async () => {
    await writeKoiFile("TOOLS.md", "Use tool X carefully.");

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]?.text).toBe("Use tool X carefully.");
    expect(result.value.sources[0]?.label).toBe("Tool Guidelines");
  });

  test("resolves project-level CONTEXT.md", async () => {
    await writeKoiFile("CONTEXT.md", "Domain context here.");

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]?.text).toBe("Domain context here.");
    expect(result.value.sources[0]?.label).toBe("Domain Context");
  });

  test("resolves all 3 default slots in parallel", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "instructions");
    await writeKoiFile("TOOLS.md", "tools");
    await writeKoiFile("CONTEXT.md", "context");

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(3);
    expect(result.value.resolved).toHaveLength(3);

    const labels = result.value.sources.map((s) => s.label);
    expect(labels).toContain("Agent Instructions");
    expect(labels).toContain("Tool Guidelines");
    expect(labels).toContain("Domain Context");
  });

  test("agent-specific INSTRUCTIONS.md overrides project-level", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "project instructions");
    await writeKoiFile("agents/my-agent/INSTRUCTIONS.md", "agent instructions");

    const result = await resolveBootstrap({ rootDir: tempDir, agentName: "my-agent" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instructions = result.value.sources.find((s) => s.label === "Agent Instructions");
    expect(instructions).toBeDefined();
    expect(instructions?.text).toBe("agent instructions");
  });

  test("agent-specific for one slot, project-level for another (mixed)", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "project instructions");
    await writeKoiFile("TOOLS.md", "project tools");
    await writeKoiFile("agents/my-agent/INSTRUCTIONS.md", "agent instructions");

    const result = await resolveBootstrap({ rootDir: tempDir, agentName: "my-agent" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(2);

    const instructions = result.value.sources.find((s) => s.label === "Agent Instructions");
    const tools = result.value.sources.find((s) => s.label === "Tool Guidelines");
    expect(instructions?.text).toBe("agent instructions");
    expect(tools?.text).toBe("project tools");
  });

  test("agent name provided but no agent dir falls back to project-level", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "project instructions");

    const result = await resolveBootstrap({ rootDir: tempDir, agentName: "nonexistent" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]?.text).toBe("project instructions");
  });

  test("custom slots override default slots", async () => {
    const customSlots: readonly BootstrapSlot[] = [
      { fileName: "CUSTOM.md", label: "Custom Slot", budget: 2_000 },
    ];
    await writeKoiFile("CUSTOM.md", "custom content");

    const result = await resolveBootstrap({ rootDir: tempDir, slots: customSlots });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]?.label).toBe("Custom Slot");
    expect(result.value.sources[0]?.text).toBe("custom content");
  });

  test("empty slots array returns ok with empty sources", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "should not be read");

    const result = await resolveBootstrap({ rootDir: tempDir, slots: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toEqual([]);
  });

  test("returns warnings for truncated files", async () => {
    const customSlots: readonly BootstrapSlot[] = [
      { fileName: "INSTRUCTIONS.md", label: "Agent Instructions", budget: 10 },
    ];
    // Content exceeds budget (10 chars) but stays within 8x size guard (80 bytes)
    await writeKoiFile("INSTRUCTIONS.md", "x".repeat(50));

    const result = await resolveBootstrap({ rootDir: tempDir, slots: customSlots });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.length).toBeGreaterThan(0);
    expect(result.value.warnings[0]).toContain("truncated");
  });

  test("skips files larger than 8x budget with warning", async () => {
    const customSlots: readonly BootstrapSlot[] = [
      { fileName: "INSTRUCTIONS.md", label: "Agent Instructions", budget: 10 },
    ];
    // File must be > 8x budget in bytes. 81 ASCII chars = 81 bytes > 8 * 10
    await writeKoiFile("INSTRUCTIONS.md", "x".repeat(81));

    const result = await resolveBootstrap({ rootDir: tempDir, slots: customSlots });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(0);
    expect(result.value.warnings.length).toBeGreaterThan(0);
    expect(result.value.warnings[0]).toContain("exceeds");
  });

  test("returns ok with empty sources when all files missing", async () => {
    // Create .koi/ but no files in it
    await writeKoiFile(".gitkeep", "");

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toEqual([]);
  });

  test("handles unicode content correctly", async () => {
    const unicodeContent = "Hello \u{1F600} world \u00E9\u00E0\u00FC \u4F60\u597D";
    await writeKoiFile("INSTRUCTIONS.md", unicodeContent);

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.text).toBe(unicodeContent);
  });

  test("returns error for empty rootDir", async () => {
    const result = await resolveBootstrap({ rootDir: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("default budgets applied when slots not provided", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "content");

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = result.value.resolved[0];
    expect(resolved).toBeDefined();
    // Default budget for INSTRUCTIONS.md is 8000
    expect(resolved?.truncated).toBe(false);
  });

  test("same content produces same hash", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "identical content");

    const result1 = await resolveBootstrap({ rootDir: tempDir });
    const result2 = await resolveBootstrap({ rootDir: tempDir });
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;

    expect(result1.value.resolved[0]?.contentHash).toBe(result2.value.resolved[0]?.contentHash);
  });

  test("different content produces different hash", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "content A");
    const result1 = await resolveBootstrap({ rootDir: tempDir });

    await writeKoiFile("INSTRUCTIONS.md", "content B");
    const result2 = await resolveBootstrap({ rootDir: tempDir });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;

    expect(result1.value.resolved[0]?.contentHash).not.toBe(result2.value.resolved[0]?.contentHash);
  });

  test("sources have priority assigned by slot order", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "instructions");
    await writeKoiFile("TOOLS.md", "tools");
    await writeKoiFile("CONTEXT.md", "context");

    const result = await resolveBootstrap({ rootDir: tempDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Priority should be 0, 1, 2 based on slot index
    expect(result.value.sources[0]?.priority).toBe(0);
    expect(result.value.sources[1]?.priority).toBe(1);
    expect(result.value.sources[2]?.priority).toBe(2);
  });
});

describe("DEFAULT_SLOTS", () => {
  test("has 3 default slots", () => {
    expect(DEFAULT_SLOTS).toHaveLength(3);
  });

  test("includes INSTRUCTIONS.md, TOOLS.md, CONTEXT.md", () => {
    const fileNames = DEFAULT_SLOTS.map((s) => s.fileName);
    expect(fileNames).toEqual(["INSTRUCTIONS.md", "TOOLS.md", "CONTEXT.md"]);
  });

  test("INSTRUCTIONS.md has 8000 budget", () => {
    expect(DEFAULT_SLOTS[0]?.budget).toBe(8_000);
  });

  test("TOOLS.md and CONTEXT.md have 4000 budget", () => {
    expect(DEFAULT_SLOTS[1]?.budget).toBe(4_000);
    expect(DEFAULT_SLOTS[2]?.budget).toBe(4_000);
  });
});
