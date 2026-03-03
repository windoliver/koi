/**
 * Tests for the attach_capability tool — 7 scenarios per plan.
 */

import { describe, expect, test } from "bun:test";
import type {
  CatalogEntry,
  CatalogPage,
  CatalogQuery,
  CatalogReader,
  KoiError,
  Result,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import type { AttachConfig } from "./attach-capability.js";
import { createAttachCapabilityTool } from "./attach-capability.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_ENTRY: CatalogEntry = {
  name: "forged:my-tool",
  kind: "tool",
  source: "forged",
  description: "A forged tool",
};

const MIDDLEWARE_ENTRY: CatalogEntry = {
  name: "bundled:@koi/middleware-audit",
  kind: "middleware",
  source: "bundled",
  description: "Audit middleware",
};

const CHANNEL_ENTRY: CatalogEntry = {
  name: "bundled:@koi/channel-cli",
  kind: "channel",
  source: "bundled",
  description: "CLI channel",
};

const ALL_ENTRIES: readonly CatalogEntry[] = [TOOL_ENTRY, MIDDLEWARE_ENTRY, CHANNEL_ENTRY];

function createMockReader(entries: readonly CatalogEntry[]): CatalogReader {
  return {
    search: async (_query: CatalogQuery): Promise<CatalogPage> => ({
      items: entries,
      total: entries.length,
    }),
    get: async (name: string): Promise<Result<CatalogEntry, KoiError>> => {
      const entry = entries.find((e) => e.name === name);
      if (entry === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${name}`, retryable: false },
        };
      }
      return { ok: true, value: entry };
    },
  };
}

function createDefaultConfig(overrides?: Partial<AttachConfig>): AttachConfig {
  return {
    allowedKinds: overrides?.allowedKinds ?? ["tool", "skill"],
    onAttach: overrides?.onAttach ?? (async () => ({ ok: true, value: undefined })),
  };
}

// ---------------------------------------------------------------------------
// Tests — 7 scenarios
// ---------------------------------------------------------------------------

describe("attach_capability tool", () => {
  test("1. capability not in catalog — NOT_FOUND", async () => {
    const reader = createMockReader([]);
    const agent = createMockAgent();
    const tool = createAttachCapabilityTool(reader, agent, createDefaultConfig());

    const result = (await tool.execute({ name: "forged:nonexistent" })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
  });

  test("2. already installed — idempotent success", async () => {
    const reader = createMockReader(ALL_ENTRIES);
    const components = new Map<string, unknown>([[toolToken("my-tool"), {}]]);
    const agent = createMockAgent({ components });
    const tool = createAttachCapabilityTool(reader, agent, createDefaultConfig());

    const result = (await tool.execute({ name: "forged:my-tool" })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.message as string).toContain("already attached");
  });

  test("3. permission denied: middleware — PERMISSION_DENIED", async () => {
    const reader = createMockReader(ALL_ENTRIES);
    const agent = createMockAgent();
    const config = createDefaultConfig({ allowedKinds: ["tool", "skill"] });
    const tool = createAttachCapabilityTool(reader, agent, config);

    const result = (await tool.execute({ name: "bundled:@koi/middleware-audit" })) as Record<
      string,
      unknown
    >;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PERMISSION_DENIED");
  });

  test("4. permission denied: channel — PERMISSION_DENIED", async () => {
    const reader = createMockReader(ALL_ENTRIES);
    const agent = createMockAgent();
    const config = createDefaultConfig({ allowedKinds: ["tool", "skill"] });
    const tool = createAttachCapabilityTool(reader, agent, config);

    const result = (await tool.execute({ name: "bundled:@koi/channel-cli" })) as Record<
      string,
      unknown
    >;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PERMISSION_DENIED");
  });

  test("5. dynamic import failure — INTERNAL error with cause", async () => {
    const reader = createMockReader(ALL_ENTRIES);
    const agent = createMockAgent();
    const config = createDefaultConfig({
      onAttach: async () => {
        throw new Error("Module not found: @koi/middleware-audit");
      },
    });
    const tool = createAttachCapabilityTool(reader, agent, config);

    const result = (await tool.execute({ name: "forged:my-tool" })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("INTERNAL");
    expect(result.message as string).toContain("Module not found");
  });

  test("6. attach returns error result — propagates error", async () => {
    const reader = createMockReader(ALL_ENTRIES);
    const agent = createMockAgent();
    const config = createDefaultConfig({
      onAttach: async () => ({
        ok: false,
        error: { code: "PERMISSION", message: "Trust tier too low", retryable: false },
      }),
    });
    const tool = createAttachCapabilityTool(reader, agent, config);

    const result = (await tool.execute({ name: "forged:my-tool" })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("PERMISSION");
  });

  test("7. successful attach for tool kind", async () => {
    const reader = createMockReader(ALL_ENTRIES);
    const agent = createMockAgent();
    let attached = false;
    const config = createDefaultConfig({
      onAttach: async () => {
        attached = true;
        return { ok: true, value: undefined };
      },
    });
    const tool = createAttachCapabilityTool(reader, agent, config);

    const result = (await tool.execute({ name: "forged:my-tool" })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(attached).toBe(true);
    expect(result.message as string).toContain("Successfully attached");
  });
});
