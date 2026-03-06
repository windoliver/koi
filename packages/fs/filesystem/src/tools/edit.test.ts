import { describe, expect, test } from "bun:test";
import type { FileEdit, FileEditOptions } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createFailingBackend, createMockBackend } from "../test-helpers.js";
import { createFsEditTool } from "./edit.js";

describe("createFsEditTool", () => {
  test("returns edit result on success", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/src/index.ts",
      edits: [{ oldText: "foo", newText: "bar" }],
    })) as { readonly path: string; readonly hunksApplied: number };

    expect(result.path).toBe("/src/index.ts");
    expect(result.hunksApplied).toBe(1);
  });

  test("passes multiple edits to backend", async () => {
    let receivedEdits: readonly FileEdit[] = [];
    const backend = {
      ...createMockBackend(),
      edit: (path: string, edits: readonly FileEdit[]) => {
        receivedEdits = edits;
        return {
          ok: true as const,
          value: { path, hunksApplied: edits.length },
        };
      },
    };

    const tool = createFsEditTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({
      path: "/test",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });

    expect(receivedEdits).toHaveLength(2);
    expect(receivedEdits[0]).toEqual({ oldText: "a", newText: "b" });
    expect(receivedEdits[1]).toEqual({ oldText: "c", newText: "d" });
  });

  test("passes dryRun option to backend", async () => {
    let receivedOptions: FileEditOptions | undefined;
    const backend = {
      ...createMockBackend(),
      edit: (path: string, edits: readonly FileEdit[], options?: FileEditOptions) => {
        receivedOptions = options;
        return {
          ok: true as const,
          value: { path, hunksApplied: edits.length },
        };
      },
    };

    const tool = createFsEditTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({
      path: "/test",
      edits: [{ oldText: "x", newText: "y" }],
      dryRun: true,
    });

    expect(receivedOptions).toEqual({ dryRun: true });
  });

  test("returns error object on backend failure", async () => {
    const tool = createFsEditTool(createFailingBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/locked",
      edits: [{ oldText: "a", newText: "b" }],
    })) as { readonly error: string; readonly code: string };

    expect(result.error).toBe("backend unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name and required fields", () => {
    const tool = createFsEditTool(createMockBackend(), "nx", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("nx_edit");
    expect(tool.policy.sandbox).toBe(true);

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("path");
    expect(required).toContain("edits");
  });

  test("handles async backend", async () => {
    const backend = {
      ...createMockBackend(),
      edit: async (path: string, edits: readonly FileEdit[]) => {
        await Promise.resolve();
        return {
          ok: true as const,
          value: { path, hunksApplied: edits.length },
        };
      },
    };

    const tool = createFsEditTool(backend, "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({
      path: "/a",
      edits: [
        { oldText: "1", newText: "2" },
        { oldText: "3", newText: "4" },
      ],
    })) as { readonly hunksApplied: number };
    expect(result.hunksApplied).toBe(2);
  });

  test("returns validation error when edits is not an array", async () => {
    const tool = createFsEditTool(createMockBackend(), "fs", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ path: "/test", edits: "oops" })) as {
      readonly error: string;
      readonly code: string;
    };
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("edits");
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
});
