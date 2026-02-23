import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalResolver } from "./local-resolver.js";

describe("LocalResolver", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "koi-resolver-test-"));
    // Create a test tool definition
    await Bun.write(
      join(testDir, "calc.tool.json"),
      JSON.stringify({
        name: "calculator",
        description: "A simple calculator",
        inputSchema: { type: "object", properties: { expression: { type: "string" } } },
        command: 'echo "result: $TOOL_ARGS"',
      }),
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("discover", () => {
    it("discovers built-in tools when enabled", async () => {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: true, shell: true },
      });
      const tools = await resolver.discover();
      const names = tools.map((t) => t.name);
      expect(names).toContain("filesystem");
      expect(names).toContain("shell");
    });

    it("does not include disabled built-ins", async () => {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: false, shell: false },
      });
      const tools = await resolver.discover();
      expect(tools.length).toBe(0);
    });

    it("discovers tools from directory", async () => {
      const resolver = createLocalResolver({
        directories: [testDir],
        builtins: { filesystem: false, shell: false },
      });
      const tools = await resolver.discover();
      const names = tools.map((t) => t.name);
      expect(names).toContain("calculator");
    });

    it("handles non-existent directory gracefully", async () => {
      const resolver = createLocalResolver({
        directories: ["/nonexistent/path"],
        builtins: { filesystem: true, shell: false },
      });
      const tools = await resolver.discover();
      // Should still have built-in filesystem
      expect(tools.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("load", () => {
    it("loads a built-in tool", async () => {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: true, shell: false },
      });
      const result = await resolver.load("filesystem");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.descriptor.name).toBe("filesystem");
      }
    });

    it("loads a directory tool", async () => {
      const resolver = createLocalResolver({
        directories: [testDir],
        builtins: { filesystem: false, shell: false },
      });
      const result = await resolver.load("calculator");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.descriptor.name).toBe("calculator");
        expect(result.value.trustTier).toBe("sandbox");
      }
    });

    it("returns NOT_FOUND for unknown tool", async () => {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: false, shell: false },
      });
      const result = await resolver.load("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("source", () => {
    it("returns JSON content for directory tool", async () => {
      const resolver = createLocalResolver({
        directories: [testDir],
        builtins: { filesystem: false, shell: false },
      });
      const result = await resolver.source("calculator");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.language).toBe("json");
        const parsed = JSON.parse(result.value.content);
        expect(parsed.name).toBe("calculator");
      }
    });

    it("returns NOT_FOUND with actionable message for built-in tool", async () => {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: true, shell: false },
      });
      const result = await resolver.source("filesystem");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toContain("Shadow pattern");
      }
    });

    it("returns NOT_FOUND for unknown tool", async () => {
      const resolver = createLocalResolver({
        directories: [],
        builtins: { filesystem: false, shell: false },
      });
      const result = await resolver.source("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});
