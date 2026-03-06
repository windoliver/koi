import { describe, expect, test } from "bun:test";
import type { FileListOptions } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createFailingBackend, createMockBackend } from "../test-helpers.js";
import { createFsListTool } from "./list.js";

describe("createFsListTool", () => {
  test("returns list result on success", async () => {
    const tool = createFsListTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/src" })) as {
      readonly entries: readonly { readonly path: string; readonly kind: string }[];
      readonly truncated: boolean;
    };

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe("/src/file.ts");
    expect(result.entries[0]?.kind).toBe("file");
    expect(result.truncated).toBe(false);
  });

  test("passes options to backend", async () => {
    let receivedOptions: FileListOptions | undefined;
    const backend = {
      ...createMockBackend(),
      list: (_path: string, options?: FileListOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { entries: [], truncated: false },
        };
      },
    };

    const tool = createFsListTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ path: "/src", recursive: true, glob: "*.ts" });

    expect(receivedOptions).toEqual({ recursive: true, glob: "*.ts" });
  });

  test("omits undefined options", async () => {
    let receivedOptions: FileListOptions | undefined;
    const backend = {
      ...createMockBackend(),
      list: (_path: string, options?: FileListOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { entries: [], truncated: false },
        };
      },
    };

    const tool = createFsListTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ path: "/src" });

    expect(receivedOptions).toEqual({});
  });

  test("returns error object on backend failure", async () => {
    const tool = createFsListTool(createFailingBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/nonexistent" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and required fields", () => {
    const tool = createFsListTool(createMockBackend(), "s3", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("s3_list");
    expect(tool.policy.sandbox).toBe(false);

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("path");
  });

  test("handles async backend", async () => {
    const backend = {
      ...createMockBackend(),
      list: async (path: string) => {
        await Promise.resolve();
        return {
          ok: true as const,
          value: {
            entries: [{ path: `${path}/a.ts`, kind: "file" as const }],
            truncated: false,
          },
        };
      },
    };

    const tool = createFsListTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/src" })) as {
      readonly entries: readonly { readonly path: string }[];
    };
    expect(result.entries[0]?.path).toBe("/src/a.ts");
  });

  test("returns validation error when path is missing", async () => {
    const tool = createFsListTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as { readonly error: string; readonly code: string };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("path");
  });
});
