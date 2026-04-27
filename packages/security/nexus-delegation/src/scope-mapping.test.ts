import { describe, expect, test } from "bun:test";
import type { DelegationScope } from "@koi/core";
import { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";

describe("mapNamespaceMode", () => {
  test("maps 'copy' to 'COPY'", () => {
    expect(mapNamespaceMode("copy")).toBe("COPY");
  });
  test("maps 'clean' to 'CLEAN'", () => {
    expect(mapNamespaceMode("clean")).toBe("CLEAN");
  });
  test("maps 'shared' to 'SHARED'", () => {
    expect(mapNamespaceMode("shared")).toBe("SHARED");
  });
  test("maps undefined to 'COPY'", () => {
    expect(mapNamespaceMode(undefined)).toBe("COPY");
  });
});

describe("mapScopeToNexus", () => {
  test("maps allow + deny lists", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file", "write_file"], deny: ["exec"] },
    };
    const result = mapScopeToNexus(scope);
    expect(result.allowed_operations).toEqual(["read_file", "write_file"]);
    expect(result.remove_grants).toEqual(["exec"]);
    expect(result.resource_patterns).toBeUndefined();
  });

  test("includes resource_patterns when scope.resources set", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
      resources: ["/workspace/src/**"],
    };
    const result = mapScopeToNexus(scope);
    expect(result.resource_patterns).toEqual(["/workspace/src/**"]);
  });

  test("uses empty arrays when allow/deny absent", () => {
    const scope: DelegationScope = { permissions: {} };
    const result = mapScopeToNexus(scope);
    expect(result.allowed_operations).toEqual([]);
    expect(result.remove_grants).toEqual([]);
  });
});
