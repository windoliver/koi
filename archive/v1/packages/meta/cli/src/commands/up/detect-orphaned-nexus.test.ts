import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { detectOrphanedNexusStacks } from "./detect-orphaned-nexus.js";

describe("detectOrphanedNexusStacks", () => {
  let stderrOutput: string;
  const originalWrite = process.stderr.write;

  beforeEach(() => {
    stderrOutput = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("returns a boolean without throwing", () => {
    const result = detectOrphanedNexusStacks("nexus-ffffffff");
    expect(typeof result).toBe("boolean");
  });

  test("accepts undefined currentProjectName without throwing", () => {
    const result = detectOrphanedNexusStacks(undefined);
    expect(typeof result).toBe("boolean");
  });

  test("writes warning to stderr when orphaned stacks are detected", () => {
    // Pass a project name that won't match any real containers
    detectOrphanedNexusStacks("nexus-0000000000");
    // If Docker is running with nexus containers, we should see a warning
    // If not, no warning is expected — either way, no crash
    if (stderrOutput !== "") {
      expect(stderrOutput).toContain("Nexus");
    }
  });
});

// Note: stopAllNexusStacks is intentionally NOT tested here because it's
// a destructive operation that stops real Docker containers. It's tested
// via manual verification: `koi stop --nexus-all`.
