import { describe, expect, test } from "bun:test";
import { isPermissionSubset } from "./delegation.js";

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
