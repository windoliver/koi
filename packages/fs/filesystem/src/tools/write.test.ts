import { describe, expect, test } from "bun:test";
import type { FileWriteOptions } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createFailingBackend, createMockBackend } from "../test-helpers.js";
import { createFsWriteTool } from "./write.js";

describe("createFsWriteTool", () => {
  test("returns write result on success", async () => {
    const tool = createFsWriteTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/tmp/out.txt", content: "hello" })) as {
      readonly path: string;
      readonly bytesWritten: number;
    };

    expect(result.path).toBe("/tmp/out.txt");
    expect(result.bytesWritten).toBe(5);
  });

  test("passes options to backend", async () => {
    let receivedOptions: FileWriteOptions | undefined;
    const backend = {
      ...createMockBackend(),
      write: (path: string, content: string, options?: FileWriteOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { path, bytesWritten: content.length },
        };
      },
    };

    const tool = createFsWriteTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({
      path: "/test",
      content: "data",
      createDirectories: true,
      overwrite: false,
    });

    expect(receivedOptions).toEqual({ createDirectories: true, overwrite: false });
  });

  test("returns error object on backend failure", async () => {
    const tool = createFsWriteTool(createFailingBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/readonly", content: "x" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and required fields", () => {
    const tool = createFsWriteTool(createMockBackend(), "nx", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("nx_write");
    expect(tool.policy.sandbox).toBe(false);

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("path");
    expect(required).toContain("content");
  });

  test("handles async backend", async () => {
    const backend = {
      ...createMockBackend(),
      write: async (path: string, content: string) => {
        await Promise.resolve();
        return {
          ok: true as const,
          value: { path, bytesWritten: content.length },
        };
      },
    };

    const tool = createFsWriteTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/a", content: "abc" })) as {
      readonly bytesWritten: number;
    };
    expect(result.bytesWritten).toBe(3);
  });

  test("returns validation error when path is missing", async () => {
    const tool = createFsWriteTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ content: "x" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("path");
  });

  test("returns validation error when content is missing", async () => {
    const tool = createFsWriteTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/test" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("content");
  });
});
