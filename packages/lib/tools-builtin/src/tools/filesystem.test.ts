import { describe, expect, test } from "bun:test";
import type { FileEditOptions, FileReadOptions, FileWriteOptions } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createFailingBackend, createMockBackend } from "../test-helpers.js";
import { createFsEditTool } from "./edit.js";
import { createFsReadTool } from "./read.js";
import { createFsWriteTool } from "./write.js";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("createFsReadTool", () => {
  test("returns file content on success", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
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
        return { ok: true as const, value: { content: "", path, size: 0 } };
      },
    };
    const tool = createFsReadTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ path: "/test", offset: 10, limit: 50, encoding: "ascii" });
    expect(receivedOptions).toEqual({ offset: 10, limit: 50, encoding: "ascii" });
  });

  test("omits undefined options", async () => {
    let receivedOptions: FileReadOptions | undefined;
    const backend = {
      ...createMockBackend(),
      read: (path: string, options?: FileReadOptions) => {
        receivedOptions = options;
        return { ok: true as const, value: { content: "", path, size: 0 } };
      },
    };
    const tool = createFsReadTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ path: "/test" });
    expect(receivedOptions).toEqual({});
  });

  test("returns error on backend failure", async () => {
    const tool = createFsReadTool(createFailingBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/missing" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and schema", () => {
    const tool = createFsReadTool(createMockBackend(), "custom", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("custom_read");
    expect(tool.origin).toBe("primordial");
    expect(tool.policy.sandbox).toBe(true);
    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("path");
  });

  test("handles async backend", async () => {
    const backend = {
      ...createMockBackend(),
      read: async (path: string) => {
        await Promise.resolve();
        return { ok: true as const, value: { content: "async content", path, size: 13 } };
      },
    };
    const tool = createFsReadTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/async" })) as { readonly content: string };
    expect(result.content).toBe("async content");
  });

  test("returns validation error when path is missing", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("path");
  });

  test("returns validation error when path is not a string", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: 42 })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error when offset is not a number", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/test", offset: "ten" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("offset");
  });

  test("returns validation error when path is wrong type (not empty string)", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("path");
  });

  test("returns cancelled when signal is already aborted", async () => {
    const tool = createFsReadTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/test" }, { signal: AbortSignal.abort() })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe("createFsEditTool", () => {
  test("applies edits on success", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/tmp/file.ts",
      edits: [{ oldText: "file content", newText: "new content" }],
    })) as { readonly path: string; readonly hunksApplied: number };
    expect(result.path).toBe("/tmp/file.ts");
    expect(result.hunksApplied).toBe(1);
  });

  test("passes dryRun option to backend", async () => {
    let receivedOptions: FileEditOptions | undefined;
    const backend = {
      ...createMockBackend(),
      edit: (
        path: string,
        edits: readonly { readonly oldText: string; readonly newText: string }[],
        options?: FileEditOptions,
      ) => {
        receivedOptions = options;
        return { ok: true as const, value: { path, hunksApplied: edits.length } };
      },
    };
    const tool = createFsEditTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({
      path: "/test",
      edits: [{ oldText: "file content", newText: "b" }],
      dryRun: true,
    });
    expect(receivedOptions).toEqual({ dryRun: true });
  });

  test("returns error on backend read failure", async () => {
    const tool = createFsEditTool(createFailingBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/test",
      edits: [{ oldText: "a", newText: "b" }],
    })) as { readonly error: string; readonly code: string };
    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and required fields", () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("fs_edit");
    expect(tool.origin).toBe("primordial");
    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("path");
    expect(required).toContain("edits");
  });

  test("returns validation error when path is missing", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ edits: [] })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("path");
  });

  test("returns validation error when edits is not an array", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/test", edits: "not-array" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("edits");
  });

  test("returns validation error when edit hunk has wrong types", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/test",
      edits: [{ oldText: 42, newText: "bar" }],
    })) as { readonly error: string };
    expect(result.error).toContain("oldText");
  });

  test("returns validation error when edit hunk is null", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/test",
      edits: [null],
    })) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("edits[0]");
  });

  test("returns validation error when edit hunk is a primitive", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/test",
      edits: ["not-an-object"],
    })) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("edits[0]");
  });

  test("returns validation error when oldText is empty", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/test",
      edits: [{ oldText: "", newText: "bar" }],
    })) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("oldText");
    expect(result.error).toContain("empty");
  });

  test("rejects edit when oldText is not found in file", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/test",
      edits: [{ oldText: "nonexistent text", newText: "bar" }],
    })) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("NOT_FOUND");
    expect(result.error).toContain("not found");
  });

  test("rejects edit when oldText matches multiple locations", async () => {
    const backend = {
      ...createMockBackend(),
      read: (_path: string) => ({
        ok: true as const,
        value: { content: "aaa bbb aaa", path: _path, size: 11 },
      }),
    };
    const tool = createFsEditTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/test",
      edits: [{ oldText: "aaa", newText: "ccc" }],
    })) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("AMBIGUOUS");
    expect(result.error).toContain("2 locations");
  });

  test("returns cancelled when signal is already aborted", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute(
      { path: "/test", edits: [{ oldText: "file content", newText: "b" }] },
      { signal: AbortSignal.abort() },
    )) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe("createFsWriteTool", () => {
  test("writes content on success", async () => {
    const tool = createFsWriteTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/tmp/out.txt",
      content: "hello world",
    })) as { readonly path: string; readonly bytesWritten: number };
    expect(result.path).toBe("/tmp/out.txt");
    expect(result.bytesWritten).toBe(11);
  });

  test("passes options to backend", async () => {
    let receivedOptions: FileWriteOptions | undefined;
    const backend = {
      ...createMockBackend(),
      write: (path: string, content: string, options?: FileWriteOptions) => {
        receivedOptions = options;
        return { ok: true as const, value: { path, bytesWritten: content.length } };
      },
    };
    const tool = createFsWriteTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ path: "/test", content: "x", createDirectories: true, overwrite: false });
    expect(receivedOptions).toEqual({ createDirectories: true, overwrite: false });
  });

  test("defaults overwrite to false when omitted", async () => {
    let receivedOptions: FileWriteOptions | undefined;
    const backend = {
      ...createMockBackend(),
      write: (path: string, content: string, options?: FileWriteOptions) => {
        receivedOptions = options;
        return { ok: true as const, value: { path, bytesWritten: content.length } };
      },
    };
    const tool = createFsWriteTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ path: "/test", content: "x" });
    expect(receivedOptions).toEqual({ overwrite: false });
  });

  test("returns error on backend failure", async () => {
    const tool = createFsWriteTool(createFailingBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/test", content: "x" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and required fields", () => {
    const tool = createFsWriteTool(createMockBackend(), "custom", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("custom_write");
    expect(tool.origin).toBe("primordial");
    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("path");
    expect(required).toContain("content");
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

  test("allows writing empty content (truncate/placeholder files)", async () => {
    const tool = createFsWriteTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/tmp/.gitkeep",
      content: "",
    })) as { readonly path: string; readonly bytesWritten: number };
    expect(result.path).toBe("/tmp/.gitkeep");
    expect(result.bytesWritten).toBe(0);
  });

  test("returns cancelled when signal is already aborted", async () => {
    const tool = createFsWriteTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute(
      { path: "/test", content: "x" },
      { signal: AbortSignal.abort() },
    )) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("CANCELLED");
  });
});
