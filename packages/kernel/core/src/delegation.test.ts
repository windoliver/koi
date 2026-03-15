import { describe, expect, test } from "bun:test";
import { intersectPermissions, isPermissionSubset, unionDenyLists } from "./delegation.js";

describe("isPermissionSubset", () => {
  test("empty child is subset of empty parent", () => {
    expect(isPermissionSubset({}, {})).toBe(true);
  });

  test("child with allows is subset when parent has same allows", () => {
    expect(
      isPermissionSubset({ allow: ["read_file"] }, { allow: ["read_file", "write_file"] }),
    ).toBe(true);
  });

  test("child with allows is subset when parent has wildcard", () => {
    expect(isPermissionSubset({ allow: ["read_file", "execute_command"] }, { allow: ["*"] })).toBe(
      true,
    );
  });

  test("child is not subset when child allow exceeds parent allow", () => {
    expect(
      isPermissionSubset({ allow: ["read_file", "execute_command"] }, { allow: ["read_file"] }),
    ).toBe(false);
  });

  test("child preserves all parent denies is subset", () => {
    expect(isPermissionSubset({ deny: ["rm", "sudo"] }, { deny: ["rm"] })).toBe(true);
  });

  test("child missing a parent deny is not subset", () => {
    expect(isPermissionSubset({ deny: ["rm"] }, { deny: ["rm", "sudo"] })).toBe(false);
  });

  test("child with no deny is not subset when parent has deny", () => {
    expect(isPermissionSubset({}, { deny: ["rm"] })).toBe(false);
  });

  test("child with additional deny beyond parent is still subset", () => {
    expect(isPermissionSubset({ deny: ["rm", "sudo", "kill"] }, { deny: ["rm"] })).toBe(true);
  });

  test("combined allow subset + deny superset is valid", () => {
    expect(
      isPermissionSubset(
        { allow: ["read_file"], deny: ["rm", "sudo"] },
        { allow: ["read_file", "write_file"], deny: ["rm"] },
      ),
    ).toBe(true);
  });

  test("combined allow exceeds but deny ok is invalid", () => {
    expect(
      isPermissionSubset(
        { allow: ["read_file", "execute_command"], deny: ["rm"] },
        { allow: ["read_file"], deny: ["rm"] },
      ),
    ).toBe(false);
  });
});

describe("intersectPermissions", () => {
  test("empty parent and child returns empty", () => {
    expect(intersectPermissions({}, {})).toEqual([]);
  });

  test("parent wildcard uses child allow list", () => {
    expect(intersectPermissions({ allow: ["*"] }, { allow: ["read_file", "write_file"] })).toEqual([
      "read_file",
      "write_file",
    ]);
  });

  test("child wildcard uses parent allow list", () => {
    expect(intersectPermissions({ allow: ["read_file", "write_file"] }, { allow: ["*"] })).toEqual([
      "read_file",
      "write_file",
    ]);
  });

  test("both wildcards returns child (which is wildcard)", () => {
    expect(intersectPermissions({ allow: ["*"] }, { allow: ["*"] })).toEqual(["*"]);
  });

  test("intersection of disjoint sets returns empty", () => {
    expect(intersectPermissions({ allow: ["read_file"] }, { allow: ["write_file"] })).toEqual([]);
  });

  test("intersection of overlapping sets returns common elements", () => {
    expect(
      intersectPermissions(
        { allow: ["read_file", "write_file", "execute"] },
        { allow: ["write_file", "execute", "delete"] },
      ),
    ).toEqual(["write_file", "execute"]);
  });

  test("preserves order from child allow list", () => {
    expect(intersectPermissions({ allow: ["a", "b", "c"] }, { allow: ["c", "a"] })).toEqual([
      "c",
      "a",
    ]);
  });
});

describe("unionDenyLists", () => {
  test("empty parent and child returns empty", () => {
    expect(unionDenyLists({}, {})).toEqual([]);
  });

  test("parent deny only returns parent deny", () => {
    expect(unionDenyLists({ deny: ["rm", "sudo"] }, {})).toEqual(["rm", "sudo"]);
  });

  test("child deny only returns child deny", () => {
    expect(unionDenyLists({}, { deny: ["rm"] })).toEqual(["rm"]);
  });

  test("overlapping denies are deduplicated", () => {
    const result = unionDenyLists({ deny: ["rm", "sudo"] }, { deny: ["sudo", "kill"] });
    expect(result).toHaveLength(3);
    expect(new Set(result)).toEqual(new Set(["rm", "sudo", "kill"]));
  });

  test("identical denies return same list", () => {
    expect(unionDenyLists({ deny: ["rm"] }, { deny: ["rm"] })).toEqual(["rm"]);
  });
});
