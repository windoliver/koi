import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIncludes } from "./include.js";

describe("processIncludes", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "koi-include-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns parsed object unchanged when no $include", async () => {
    const parsed = { logLevel: "info", maxTurns: 25 };
    const result = await processIncludes(parsed, tempDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ logLevel: "info", maxTurns: 25 });
    }
  });

  test("resolves single $include", async () => {
    writeFileSync(join(tempDir, "base.yaml"), "logLevel: info\nmaxTurns: 25\n");
    const parsed = { $include: ["base.yaml"], logLevel: "debug" };
    const result = await processIncludes(parsed, tempDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Parent overrides included value
      expect(result.value.logLevel).toBe("debug");
      expect(result.value.maxTurns).toBe(25);
    }
  });

  test("resolves nested $include", async () => {
    writeFileSync(join(tempDir, "deep.yaml"), "deep: true\n");
    writeFileSync(join(tempDir, "mid.yaml"), "$include:\n  - deep.yaml\nmid: true\n");
    const parsed = { $include: ["mid.yaml"], top: true };
    const result = await processIncludes(parsed, tempDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ deep: true, mid: true, top: true });
    }
  });

  test("detects circular $include", async () => {
    writeFileSync(join(tempDir, "a-cycle.yaml"), "$include:\n  - b-cycle.yaml\na: true\n");
    writeFileSync(join(tempDir, "b-cycle.yaml"), "$include:\n  - a-cycle.yaml\nb: true\n");
    const parsed = { $include: ["a-cycle.yaml"] };
    const result = await processIncludes(parsed, tempDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Circular");
    }
  });

  test("allows diamond $include (same file via two paths)", async () => {
    writeFileSync(join(tempDir, "shared.yaml"), "shared: true\n");
    writeFileSync(join(tempDir, "left.yaml"), "$include:\n  - shared.yaml\nleft: true\n");
    writeFileSync(join(tempDir, "right.yaml"), "$include:\n  - shared.yaml\nright: true\n");
    const parsed = { $include: ["left.yaml", "right.yaml"], top: true };
    const result = await processIncludes(parsed, tempDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ shared: true, left: true, right: true, top: true });
    }
  });

  test("rejects exceeding max depth", async () => {
    writeFileSync(join(tempDir, "depth.yaml"), "x: 1\n");
    const parsed = { $include: ["depth.yaml"] };
    const result = await processIncludes(parsed, tempDir, { maxDepth: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("max depth");
    }
  });

  test("returns error for non-array $include", async () => {
    const parsed = { $include: "base.yaml" };
    const result = await processIncludes(parsed, tempDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns error for missing included file", async () => {
    const parsed = { $include: ["nonexistent.yaml"] };
    const result = await processIncludes(parsed, tempDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
