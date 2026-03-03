import { describe, expect, test } from "bun:test";
import type { FileReadOptions } from "@koi/core";
import { createFailingBackend, createMockBackend } from "../test-helpers.js";
import { createFsReadTool } from "./read.js";

describe("createFsReadTool", () => {
  test("returns file content on success", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", "verified");
    const result = (await tool.execute({ path: "/tmp/test.txt" })) as {
      readonly content: string;
      readonly path: string;
      readonly size: number;
    };

    expect(result.content).toBe("file content");
    expect(result.path).toBe("/tmp/test.txt");
    expect(result.size).toBe(12);
  });

  test("passes options to backend", async () => {
    let receivedOptions: FileReadOptions | undefined;
    const backend = {
      ...createMockBackend(),
      read: (path: string, options?: FileReadOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { content: "", path, size: 0 },
        };
      },
    };

    const tool = createFsReadTool(backend, "fs", "verified");
    await tool.execute({ path: "/test", offset: 10, limit: 50, encoding: "ascii" });

    expect(receivedOptions).toEqual({ offset: 10, limit: 50, encoding: "ascii" });
  });

  test("omits undefined options", async () => {
    let receivedOptions: FileReadOptions | undefined;
    const backend = {
      ...createMockBackend(),
      read: (path: string, options?: FileReadOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { content: "", path, size: 0 },
        };
      },
    };

    const tool = createFsReadTool(backend, "fs", "verified");
    await tool.execute({ path: "/test" });

    expect(receivedOptions).toEqual({});
  });

  test("returns error object on backend failure", async () => {
    const tool = createFsReadTool(createFailingBackend(), "fs", "verified");
    const result = (await tool.execute({ path: "/missing" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and schema", () => {
    const tool = createFsReadTool(createMockBackend(), "custom", "sandbox");
    expect(tool.descriptor.name).toBe("custom_read");
    expect(tool.trustTier).toBe("sandbox");

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("path");
  });

  test("handles async backend", async () => {
    const backend = {
      ...createMockBackend(),
      read: async (path: string) => {
        await Promise.resolve();
        return {
          ok: true as const,
          value: { content: "async content", path, size: 13 },
        };
      },
    };

    const tool = createFsReadTool(backend, "fs", "verified");
    const result = (await tool.execute({ path: "/async" })) as {
      readonly content: string;
    };
    expect(result.content).toBe("async content");
  });

  test("returns validation error when path is missing", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", "verified");
    const result = (await tool.execute({})) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("path");
  });

  test("returns validation error when path is not a string", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", "verified");
    const result = (await tool.execute({ path: 42 })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error when offset is not a number", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", "verified");
    const result = (await tool.execute({ path: "/test", offset: "ten" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("offset");
  });
});
