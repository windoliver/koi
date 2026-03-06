import { describe, expect, test } from "bun:test";
import type { FileSearchOptions } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createFailingBackend, createMockBackend } from "../test-helpers.js";
import { createFsSearchTool } from "./search.js";

describe("createFsSearchTool", () => {
  test("returns search result on success", async () => {
    const tool = createFsSearchTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ pattern: "TODO" })) as {
      readonly matches: readonly {
        readonly path: string;
        readonly line: number;
        readonly text: string;
      }[];
      readonly truncated: boolean;
    };

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe("/src/index.ts");
    expect(result.matches[0]?.line).toBe(1);
    expect(result.matches[0]?.text).toBe("TODO");
    expect(result.truncated).toBe(false);
  });

  test("passes options to backend", async () => {
    let receivedOptions: FileSearchOptions | undefined;
    const backend = {
      ...createMockBackend(),
      search: (_pattern: string, options?: FileSearchOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { matches: [], truncated: false },
        };
      },
    };

    const tool = createFsSearchTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({
      pattern: "hello",
      glob: "**/*.ts",
      maxResults: 100,
      caseSensitive: false,
    });

    expect(receivedOptions).toEqual({
      glob: "**/*.ts",
      maxResults: 100,
      caseSensitive: false,
    });
  });

  test("omits undefined options", async () => {
    let receivedOptions: FileSearchOptions | undefined;
    const backend = {
      ...createMockBackend(),
      search: (_pattern: string, options?: FileSearchOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { matches: [], truncated: false },
        };
      },
    };

    const tool = createFsSearchTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ pattern: "hello" });

    expect(receivedOptions).toEqual({});
  });

  test("returns error object on backend failure", async () => {
    const tool = createFsSearchTool(createFailingBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ pattern: "x" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and required fields", () => {
    const tool = createFsSearchTool(createMockBackend(), "rg", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("rg_search");
    expect(tool.policy.sandbox).toBe(true);

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("pattern");
  });

  test("handles async backend", async () => {
    const backend = {
      ...createMockBackend(),
      search: async (pattern: string) => {
        await Promise.resolve();
        return {
          ok: true as const,
          value: {
            matches: [{ path: "/match.ts", line: 42, text: pattern }],
            truncated: false,
          },
        };
      },
    };

    const tool = createFsSearchTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ pattern: "async" })) as {
      readonly matches: readonly { readonly text: string }[];
    };
    expect(result.matches[0]?.text).toBe("async");
  });

  test("returns validation error when pattern is missing", async () => {
    const tool = createFsSearchTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("pattern");
  });
});
