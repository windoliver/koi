import { describe, expect, test } from "bun:test";
import type { DelegationScope } from "@koi/core";
import { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";

describe("mapNamespaceMode", () => {
  test("maps 'copy' to 'copy'", () => {
    expect(mapNamespaceMode("copy")).toBe("copy");
  });
  test("maps 'clean' to 'clean'", () => {
    expect(mapNamespaceMode("clean")).toBe("clean");
  });
  test("maps 'shared' to 'shared'", () => {
    expect(mapNamespaceMode("shared")).toBe("shared");
  });
  test("maps undefined to 'copy'", () => {
    expect(mapNamespaceMode(undefined)).toBe("copy");
  });
});

describe("mapScopeToNexus", () => {
  test("maps allow → add_grants and deny → remove_grants", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file", "write_file"], deny: ["exec"] },
    };
    const result = mapScopeToNexus(scope);
    expect(result.add_grants).toEqual(["read_file", "write_file"]);
    expect(result.remove_grants).toEqual(["exec"]);
    expect(result.readonly_paths).toEqual([]);
  });

  test("readonly_paths is always empty when scope.permissions has no readonly hint", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
      resources: ["/workspace/src/**"],
    };
    const result = mapScopeToNexus(scope);
    expect(result.readonly_paths).toEqual([]);
  });

  test("uses empty arrays when allow/deny absent", () => {
    const scope: DelegationScope = { permissions: {} };
    const result = mapScopeToNexus(scope);
    expect(result.add_grants).toEqual([]);
    expect(result.remove_grants).toEqual([]);
    expect(result.readonly_paths).toEqual([]);
  });
});
