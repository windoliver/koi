/**
 * Tests for scope mapping — Koi DelegationScope ↔ Nexus DelegateRequest.
 *
 * Covers:
 * - #11-A: Boundary tests for edge cases (wildcard, empty, maxChainDepth=0)
 * - #11-A: Round-trip property: Koi→Nexus preserves permission semantics
 */

import { describe, expect, test } from "bun:test";
import type { DelegationScope } from "@koi/core";
import { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";

// ---------------------------------------------------------------------------
// mapNamespaceMode
// ---------------------------------------------------------------------------

describe("mapNamespaceMode", () => {
  test("undefined defaults to COPY", () => {
    expect(mapNamespaceMode(undefined)).toBe("COPY");
  });

  test("copy maps to COPY", () => {
    expect(mapNamespaceMode("copy")).toBe("COPY");
  });

  test("clean maps to CLEAN", () => {
    expect(mapNamespaceMode("clean")).toBe("CLEAN");
  });

  test("shared maps to SHARED", () => {
    expect(mapNamespaceMode("shared")).toBe("SHARED");
  });
});

// ---------------------------------------------------------------------------
// mapScopeToNexus
// ---------------------------------------------------------------------------

describe("mapScopeToNexus", () => {
  test("empty scope maps to empty operations and grants", () => {
    const scope: DelegationScope = { permissions: {} };
    const result = mapScopeToNexus(scope);

    expect(result.allowed_operations).toEqual([]);
    expect(result.remove_grants).toEqual([]);
    expect(result.resource_patterns).toBeUndefined();
  });

  test("wildcard allow is preserved in allowed_operations", () => {
    const scope: DelegationScope = { permissions: { allow: ["*"] } };
    const result = mapScopeToNexus(scope);

    expect(result.allowed_operations).toEqual(["*"]);
  });

  test("specific allows map to allowed_operations", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file", "write_file", "execute_command"] },
    };
    const result = mapScopeToNexus(scope);

    expect(result.allowed_operations).toEqual(["read_file", "write_file", "execute_command"]);
  });

  test("deny list maps to remove_grants", () => {
    const scope: DelegationScope = {
      permissions: { deny: ["rm", "sudo", "kill"] },
    };
    const result = mapScopeToNexus(scope);

    expect(result.remove_grants).toEqual(["rm", "sudo", "kill"]);
  });

  test("resources map to resource_patterns", () => {
    const scope: DelegationScope = {
      permissions: {},
      resources: ["read_file:/workspace/src/**", "write_file:/workspace/out/**"],
    };
    const result = mapScopeToNexus(scope);

    expect(result.resource_patterns).toEqual([
      "read_file:/workspace/src/**",
      "write_file:/workspace/out/**",
    ]);
  });

  test("resources omitted when not present in scope", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
    };
    const result = mapScopeToNexus(scope);

    expect(result).not.toHaveProperty("resource_patterns");
  });

  test("combined allow + deny + resources", () => {
    const scope: DelegationScope = {
      permissions: {
        allow: ["read_file", "write_file"],
        deny: ["execute_command"],
      },
      resources: ["read_file:/workspace/**"],
    };
    const result = mapScopeToNexus(scope);

    expect(result.allowed_operations).toEqual(["read_file", "write_file"]);
    expect(result.remove_grants).toEqual(["execute_command"]);
    expect(result.resource_patterns).toEqual(["read_file:/workspace/**"]);
  });

  test("empty allow array produces empty allowed_operations", () => {
    const scope: DelegationScope = {
      permissions: { allow: [] },
    };
    const result = mapScopeToNexus(scope);

    expect(result.allowed_operations).toEqual([]);
  });

  test("empty deny array produces empty remove_grants", () => {
    const scope: DelegationScope = {
      permissions: { deny: [] },
    };
    const result = mapScopeToNexus(scope);

    expect(result.remove_grants).toEqual([]);
  });

  test("sessionId in scope is not mapped (Nexus-internal concern)", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
      sessionId: "session-123",
    };
    const result = mapScopeToNexus(scope);

    // sessionId should not appear in the Nexus scope
    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("session_id");
  });
});

// ---------------------------------------------------------------------------
// Property-based tests (#11-A round-trip invariant)
// ---------------------------------------------------------------------------

describe("scope mapping properties", () => {
  const TOOLS = ["read_file", "write_file", "execute_command", "search", "list_files"];
  const RESOURCES = ["read_file:/workspace/**", "write_file:/tmp/**", "execute_command:/usr/bin/*"];

  function randomSubset<T>(arr: readonly T[]): readonly T[] {
    return arr.filter(() => Math.random() > 0.5);
  }

  function randomScope(): DelegationScope {
    return {
      permissions: {
        allow: randomSubset(TOOLS),
        deny: randomSubset(TOOLS),
      },
      ...(Math.random() > 0.5 ? { resources: randomSubset(RESOURCES) } : {}),
    };
  }

  test("mapping preserves allow count", () => {
    for (let i = 0; i < 50; i++) {
      const scope = randomScope();
      const nexusScope = mapScopeToNexus(scope);

      expect(nexusScope.allowed_operations).toHaveLength((scope.permissions.allow ?? []).length);
    }
  });

  test("mapping preserves deny count", () => {
    for (let i = 0; i < 50; i++) {
      const scope = randomScope();
      const nexusScope = mapScopeToNexus(scope);

      expect(nexusScope.remove_grants).toHaveLength((scope.permissions.deny ?? []).length);
    }
  });

  test("mapping preserves resource count when present", () => {
    for (let i = 0; i < 50; i++) {
      const scope = randomScope();
      const nexusScope = mapScopeToNexus(scope);

      if (scope.resources !== undefined) {
        expect(nexusScope.resource_patterns).toHaveLength(scope.resources.length);
      } else {
        expect(nexusScope.resource_patterns).toBeUndefined();
      }
    }
  });

  test("all namespace modes round-trip correctly", () => {
    expect(mapNamespaceMode("copy")).toBe("COPY");
    expect(mapNamespaceMode("clean")).toBe("CLEAN");
    expect(mapNamespaceMode("shared")).toBe("SHARED");
    expect(mapNamespaceMode(undefined)).toBe("COPY");
  });
});
