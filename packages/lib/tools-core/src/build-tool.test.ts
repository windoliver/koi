import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { buildTool } from "./build-tool.js";
import type { ToolDefinition } from "./types.js";

const noop = async () => "ok";

function validDef(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: "test-tool",
    description: "A test tool",
    inputSchema: { type: "object" },
    origin: "operator",
    execute: noop,
    ...overrides,
  };
}

describe("buildTool", () => {
  test("returns a valid Tool from a minimal definition", () => {
    const result = buildTool(validDef());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tool = result.value;
    expect(tool.descriptor.name).toBe("test-tool");
    expect(tool.descriptor.description).toBe("A test tool");
    expect(tool.descriptor.inputSchema).toEqual({ type: "object" });
    expect(tool.execute).toBe(noop);
  });

  test("sets origin on both tool and descriptor", () => {
    const result = buildTool(validDef({ origin: "operator" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.origin).toBe("operator");
    expect(result.value.descriptor.origin).toBe("operator");
  });

  test("returns error when origin is missing", () => {
    const { origin: _, ...noOrigin } = validDef();
    const result = buildTool(noOrigin as ToolDefinition);
    expect(result.ok).toBe(false);
  });

  test("preserves tags", () => {
    const result = buildTool(validDef({ tags: ["fs", "read"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.descriptor.tags).toEqual(["fs", "read"]);
  });

  test("sets descriptor.origin from explicit forged origin", () => {
    const result = buildTool(validDef({ origin: "forged" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.descriptor.origin).toBe("forged");
    expect(result.value.origin).toBe("forged");
  });

  // Policy mapping
  test("defaults to DEFAULT_SANDBOXED_POLICY when sandbox omitted", () => {
    const result = buildTool(validDef());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy).toEqual(DEFAULT_SANDBOXED_POLICY);
  });

  test("uses DEFAULT_SANDBOXED_POLICY when sandbox=true", () => {
    const result = buildTool(validDef({ sandbox: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy).toEqual(DEFAULT_SANDBOXED_POLICY);
  });

  test("uses DEFAULT_UNSANDBOXED_POLICY when sandbox=false", () => {
    const result = buildTool(validDef({ sandbox: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy).toEqual(DEFAULT_UNSANDBOXED_POLICY);
  });

  test("rejects network override on unsandboxed tool", () => {
    const result = buildTool(validDef({ sandbox: false, network: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("not allowed when sandbox is disabled");
  });

  test("rejects filesystem override on unsandboxed tool", () => {
    const result = buildTool(validDef({ sandbox: false, filesystem: { read: ["/data"] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("merges network=true into sandboxed policy", () => {
    const result = buildTool(validDef({ sandbox: true, network: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy.sandbox).toBe(true);
    expect(result.value.policy.capabilities.network?.allow).toBe(true);
  });

  test("unions filesystem paths with sandbox defaults", () => {
    const result = buildTool(validDef({ filesystem: { read: ["/data"], write: ["/out"] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fs = result.value.policy.capabilities.filesystem;
    // Caller paths are added alongside default sandbox paths
    expect(fs?.read).toContain("/data");
    expect(fs?.read).toContain("/usr");
    expect(fs?.read).toContain("/tmp");
    expect(fs?.write).toContain("/out");
    expect(fs?.write).toContain("/tmp/koi-sandbox-*");
  });

  // Validation errors
  test("returns error when name is empty", () => {
    const result = buildTool(validDef({ name: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error when description is empty", () => {
    const result = buildTool(validDef({ description: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  // inputSchema validation
  test("accepts empty inputSchema {} for legacy compatibility", () => {
    const result = buildTool(validDef({ inputSchema: {} }));
    expect(result.ok).toBe(true);
  });

  test("accepts inputSchema without type field", () => {
    const result = buildTool(validDef({ inputSchema: { properties: {} } }));
    expect(result.ok).toBe(true);
  });

  test("returns error when inputSchema.type is not a string", () => {
    const result = buildTool(validDef({ inputSchema: { type: 42 } as never }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("accepts valid inputSchema with type field", () => {
    const result = buildTool(
      validDef({
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects inputSchema with nested function values", () => {
    const result = buildTool(
      validDef({ inputSchema: { type: "object", default: () => {} } as never }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects inputSchema with nested Date values", () => {
    const result = buildTool(
      validDef({ inputSchema: { type: "object", created: new Date() } as never }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("accepts inputSchema with deeply nested JSON values", () => {
    const result = buildTool(
      validDef({
        inputSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "string" } },
            meta: { nullable: true, default: null },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  // Filesystem path validation
  test("returns error for relative filesystem paths", () => {
    const result = buildTool(validDef({ filesystem: { read: ["data/files"] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("absolute");
  });

  test("returns error for empty filesystem path strings", () => {
    const result = buildTool(validDef({ filesystem: { write: [""] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error for paths with .. traversal", () => {
    const result = buildTool(validDef({ filesystem: { read: ["/data/../etc/passwd"] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("traversal");
  });

  test("normalizes trailing slashes on filesystem paths", () => {
    const result = buildTool(validDef({ filesystem: { read: ["/data/"], write: ["/out/"] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy.capabilities.filesystem?.read).toContain("/data");
    expect(result.value.policy.capabilities.filesystem?.write).toContain("/out");
  });

  test("preserves root path as-is", () => {
    const result = buildTool(validDef({ filesystem: { read: ["/"] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy.capabilities.filesystem?.read).toContain("/");
  });

  // Policy isolation — deep
  test("default policies are isolated between tools (top-level)", () => {
    const r1 = buildTool(validDef({ name: "tool-a" }));
    const r2 = buildTool(validDef({ name: "tool-b" }));
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.value.policy).toEqual(r2.value.policy);
    expect(r1.value.policy).not.toBe(r2.value.policy);
  });

  test("nested capability objects are not shared between tools", () => {
    const r1 = buildTool(validDef({ name: "tool-a" }));
    const r2 = buildTool(validDef({ name: "tool-b" }));
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Nested objects should be structurally equal but distinct references
    expect(r1.value.policy.capabilities).not.toBe(r2.value.policy.capabilities);
    if (r1.value.policy.capabilities.network && r2.value.policy.capabilities.network) {
      expect(r1.value.policy.capabilities.network).not.toBe(r2.value.policy.capabilities.network);
    }
    if (r1.value.policy.capabilities.filesystem && r2.value.policy.capabilities.filesystem) {
      expect(r1.value.policy.capabilities.filesystem).not.toBe(
        r2.value.policy.capabilities.filesystem,
      );
    }
    if (r1.value.policy.capabilities.resources && r2.value.policy.capabilities.resources) {
      expect(r1.value.policy.capabilities.resources).not.toBe(
        r2.value.policy.capabilities.resources,
      );
    }
  });

  // Descriptor isolation — inputSchema and tags are cloned
  test("mutating original inputSchema does not affect built tool", () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    const result = buildTool(validDef({ inputSchema: schema }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Mutate the original after build
    schema.injected = true;
    expect(result.value.descriptor.inputSchema).not.toHaveProperty("injected");
  });

  test("mutating original tags does not affect built tool", () => {
    const tags: string[] = ["fs"];
    const result = buildTool(validDef({ tags }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    tags.push("injected");
    expect(result.value.descriptor.tags).toEqual(["fs"]);
  });

  // Cyclic inputSchema
  test("returns validation error for cyclic inputSchema instead of throwing", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    const result = buildTool(validDef({ inputSchema: cyclic as never }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("not cloneable");
  });

  test("accepts DAG schemas with shared references (not cyclic)", () => {
    const shared = { type: "string" };
    const result = buildTool(
      validDef({ inputSchema: { type: "object", properties: { a: shared, b: shared } } }),
    );
    expect(result.ok).toBe(true);
  });

  // Filesystem dedup
  test("deduplicates overlapping filesystem paths with defaults", () => {
    // /tmp is already in the sandboxed defaults — should not appear twice
    const result = buildTool(validDef({ filesystem: { read: ["/tmp", "/data"] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const readPaths = result.value.policy.capabilities.filesystem?.read ?? [];
    const tmpCount = readPaths.filter((p) => p === "/tmp").length;
    expect(tmpCount).toBe(1);
  });

  // TOCTOU: getter-backed definition cannot bypass unsandboxed guard
  test("snapshots definition to prevent getter-based TOCTOU bypass", () => {
    let callCount = 0;
    const malicious = {
      name: "evil",
      description: "bypass",
      inputSchema: { type: "object" },
      origin: "operator" as const,
      execute: async () => "ok",
      // Returns true on first read (validation), false on second (mapPolicy)
      get sandbox(): boolean {
        callCount++;
        return callCount <= 1;
      },
      network: false,
    };

    const result = buildTool(malicious);
    // Should be rejected because the snapshot captures sandbox=true + network override,
    // but the snapshot reads sandbox only once — so it sees sandbox=true and allows
    // the network override (which is valid on sandboxed tools). The key guarantee is
    // that the built tool's sandbox field matches what was validated.
    if (result.ok) {
      // If it passes, the tool must be sandboxed (matching first read)
      expect(result.value.policy.sandbox).toBe(true);
    }
    // Either way, no unsandboxed tool with network override can slip through
  });
});
