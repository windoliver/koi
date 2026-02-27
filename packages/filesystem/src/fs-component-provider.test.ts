import { describe, expect, test } from "bun:test";
import type { AttachResult, FileSystemBackend, Tool } from "@koi/core";
import { FILESYSTEM, isAttachResult, toolToken } from "@koi/core";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

import { createFileSystemProvider } from "./fs-component-provider.js";
import { createMockAgent, createMockBackend } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// createFileSystemProvider — attach
// ---------------------------------------------------------------------------

describe("createFileSystemProvider", () => {
  test("provider name includes backend name", () => {
    const backend = createMockBackend("nexus");
    const provider = createFileSystemProvider({ backend });
    expect(provider.name).toBe("filesystem:nexus");
  });

  test("attaches all 5 tools by default", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.size).toBe(6); // 5 tools + FILESYSTEM token
    expect(components.has(toolToken("fs_read") as string)).toBe(true);
    expect(components.has(toolToken("fs_write") as string)).toBe(true);
    expect(components.has(toolToken("fs_edit") as string)).toBe(true);
    expect(components.has(toolToken("fs_list") as string)).toBe(true);
    expect(components.has(toolToken("fs_search") as string)).toBe(true);
  });

  test("attaches the backend under FILESYSTEM token", async () => {
    const backend = createMockBackend("nexus");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.get(FILESYSTEM as string)).toBe(backend);
  });

  test("respects custom prefix", async () => {
    const backend = createMockBackend("s3");
    const provider = createFileSystemProvider({ backend, prefix: "s3" });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("s3_read") as string)).toBe(true);
    expect(components.has(toolToken("s3_write") as string)).toBe(true);
    expect(components.has(toolToken("fs_read") as string)).toBe(false);
  });

  test("respects custom trust tier", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend, trustTier: "sandbox" });
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("fs_read") as string) as Tool;
    expect(tool.trustTier).toBe("sandbox");
  });

  test("defaults trust tier to verified", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("fs_read") as string) as Tool;
    expect(tool.trustTier).toBe("verified");
  });

  test("respects operations filter", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({
      backend,
      operations: ["read", "list"],
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    // 2 tools + FILESYSTEM token
    expect(components.size).toBe(3);
    expect(components.has(toolToken("fs_read") as string)).toBe(true);
    expect(components.has(toolToken("fs_list") as string)).toBe(true);
    expect(components.has(toolToken("fs_write") as string)).toBe(false);
    expect(components.has(toolToken("fs_edit") as string)).toBe(false);
    expect(components.has(toolToken("fs_search") as string)).toBe(false);
  });

  test("empty operations throws", () => {
    const backend = createMockBackend("local");
    expect(() => createFileSystemProvider({ backend, operations: [] })).toThrow(
      /operations must not be empty/,
    );
  });
});

// ---------------------------------------------------------------------------
// createFileSystemProvider — detach
// ---------------------------------------------------------------------------

describe("createFileSystemProvider — detach", () => {
  test("calls backend.dispose on detach", async () => {
    let disposed = false;
    const backend: FileSystemBackend = {
      ...createMockBackend("local"),
      dispose: () => {
        disposed = true;
      },
    };
    const provider = createFileSystemProvider({ backend });

    await provider.detach?.(createMockAgent());
    expect(disposed).toBe(true);
  });

  test("detach is safe when backend has no dispose", async () => {
    const backend = createMockBackend("local");
    const provider = createFileSystemProvider({ backend });

    // Should not throw
    await provider.detach?.(createMockAgent());
  });

  test("detach awaits async dispose", async () => {
    let disposed = false;
    const backend: FileSystemBackend = {
      ...createMockBackend("local"),
      dispose: async () => {
        await Promise.resolve();
        disposed = true;
      },
    };
    const provider = createFileSystemProvider({ backend });

    await provider.detach?.(createMockAgent());
    expect(disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

describe("tool descriptors", () => {
  test("each tool has correct name and non-empty description", async () => {
    const backend = createMockBackend("test");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    const expectedNames = ["fs_read", "fs_write", "fs_edit", "fs_list", "fs_search"];
    for (const name of expectedNames) {
      const tool = components.get(toolToken(name) as string) as Tool;
      expect(tool.descriptor.name).toBe(name);
      expect(tool.descriptor.description.length).toBeGreaterThan(0);
      expect(tool.descriptor.description).toContain("test");
    }
  });

  test("each tool has inputSchema with required fields", async () => {
    const backend = createMockBackend("test");
    const provider = createFileSystemProvider({ backend });
    const components = extractMap(await provider.attach(createMockAgent()));

    for (const name of ["fs_read", "fs_write", "fs_edit", "fs_list", "fs_search"]) {
      const tool = components.get(toolToken(name) as string) as Tool;
      const schema = tool.descriptor.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.required).toBeDefined();
    }
  });
});
