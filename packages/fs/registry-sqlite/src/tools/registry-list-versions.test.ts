import { describe, expect, test } from "bun:test";
import type { VersionEntry } from "@koi/core";
import { brickId, DEFAULT_UNSANDBOXED_POLICY, publisherId } from "@koi/core";
import { createRegistryListVersionsTool } from "./registry-list-versions.js";
import { createMockFacade } from "./test-helpers.js";

const VERSIONS: readonly VersionEntry[] = [
  {
    version: "2.0.0",
    brickId: brickId("brick_v2"),
    publisher: publisherId("pub-1"),
    publishedAt: 1_700_000_002_000,
  },
  {
    version: "1.0.0",
    brickId: brickId("brick_v1"),
    publisher: publisherId("pub-1"),
    publishedAt: 1_700_000_001_000,
    deprecated: true,
  },
];

describe("registry_list_versions tool", () => {
  test("returns NOT_FOUND when no versions exist", async () => {
    const facade = createMockFacade();
    const tool = createRegistryListVersionsTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({ name: "missing", kind: "tool" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("NOT_FOUND");
  });

  test("returns multiple versions with count", async () => {
    const facade = createMockFacade({
      versions: {
        listVersions: () => ({ ok: true, value: VERSIONS }),
      },
    });
    const tool = createRegistryListVersionsTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({ name: "my-tool", kind: "tool" })) as Record<
      string,
      unknown
    >;
    const versions = result.versions as readonly Record<string, unknown>[];

    expect(result.count).toBe(2);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.version).toBe("2.0.0");
    expect(versions[1]?.version).toBe("1.0.0");
  });

  test("includes deprecated flag when true", async () => {
    const facade = createMockFacade({
      versions: {
        listVersions: () => ({ ok: true, value: VERSIONS }),
      },
    });
    const tool = createRegistryListVersionsTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({ name: "my-tool", kind: "tool" })) as Record<
      string,
      unknown
    >;
    const versions = result.versions as readonly Record<string, unknown>[];

    expect(versions[0]?.deprecated).toBeUndefined();
    expect(versions[1]?.deprecated).toBe(true);
  });

  test("returns validation error for missing name", async () => {
    const facade = createMockFacade();
    const tool = createRegistryListVersionsTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({ kind: "tool" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for missing kind", async () => {
    const facade = createMockFacade();
    const tool = createRegistryListVersionsTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({ name: "test" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });
});
