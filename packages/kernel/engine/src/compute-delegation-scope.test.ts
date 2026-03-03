import { describe, expect, test } from "bun:test";
import { computeChildDelegationScope } from "./compute-delegation-scope.js";

describe("computeChildDelegationScope", () => {
  test("parent allow:* + child allow:[fs_read] → child gets [fs_read]", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["*"] } },
      { allow: ["fs_read"] },
    );
    expect(result.permissions.allow).toEqual(["fs_read"]);
    expect(result.permissions.deny).toBeUndefined();
  });

  test("parent allow:[fs_read, fs_write] + child allow:[fs_read] → child gets [fs_read]", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["fs_read", "fs_write"] } },
      { allow: ["fs_read"] },
    );
    expect(result.permissions.allow).toEqual(["fs_read"]);
  });

  test("parent allow:[fs_read] + child allow:[fs_read, fs_write] → child gets [fs_read]", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["fs_read"] } },
      { allow: ["fs_read", "fs_write"] },
    );
    expect(result.permissions.allow).toEqual(["fs_read"]);
  });

  test("child allow:* with limited parent → child gets parent allow", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["fs_read", "fs_write"] } },
      { allow: ["*"] },
    );
    expect(result.permissions.allow).toEqual(["fs_read", "fs_write"]);
  });

  test("parent deny:[fs_delete] + child deny:[] → child gets deny:[fs_delete]", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["*"], deny: ["fs_delete"] } },
      { allow: ["fs_read"] },
    );
    expect(result.permissions.deny).toEqual(["fs_delete"]);
  });

  test("parent deny:[fs_delete] + child deny:[exec] → union deny:[fs_delete, exec]", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["*"], deny: ["fs_delete"] } },
      { allow: ["fs_read"], deny: ["exec"] },
    );
    const deny = result.permissions.deny ?? [];
    expect(deny).toContain("fs_delete");
    expect(deny).toContain("exec");
    expect(deny).toHaveLength(2);
  });

  test("duplicate deny entries are deduplicated", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["*"], deny: ["exec"] } },
      { allow: ["fs_read"], deny: ["exec"] },
    );
    expect(result.permissions.deny).toEqual(["exec"]);
  });

  test("parent resources + child no resources → child inherits parent resources", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["*"] }, resources: ["read_file:/src/**"] },
      { allow: ["read_file"] },
    );
    expect(result.resources).toEqual(["read_file:/src/**"]);
  });

  test("parent no resources → child has no resources", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["*"] } },
      { allow: ["read_file"] },
    );
    expect(result.resources).toBeUndefined();
  });

  test("empty allow on both sides → empty allow", () => {
    const result = computeChildDelegationScope({ permissions: {} }, {});
    expect(result.permissions.allow).toBeUndefined();
    expect(result.permissions.deny).toBeUndefined();
  });

  test("no intersection → empty allow", () => {
    const result = computeChildDelegationScope(
      { permissions: { allow: ["fs_read"] } },
      { allow: ["exec"] },
    );
    expect(result.permissions.allow).toBeUndefined();
  });
});
