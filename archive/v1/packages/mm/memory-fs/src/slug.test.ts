import { describe, expect, test } from "bun:test";
import { slugifyEntity } from "./slug.js";

describe("slugifyEntity", () => {
  test("lowercases input", () => {
    expect(slugifyEntity("Alice")).toBe("alice");
  });

  test("replaces non-alphanumeric characters with dashes", () => {
    expect(slugifyEntity("foo/bar")).toBe("foo-bar");
    expect(slugifyEntity("hello world")).toBe("hello-world");
    expect(slugifyEntity("a_b_c")).toBe("a-b-c");
  });

  test("collapses consecutive dashes", () => {
    expect(slugifyEntity("foo---bar")).toBe("foo-bar");
    expect(slugifyEntity("a   b")).toBe("a-b");
  });

  test("trims leading and trailing dashes", () => {
    expect(slugifyEntity("-hello-")).toBe("hello");
    expect(slugifyEntity("---hi---")).toBe("hi");
  });

  test("limits to 64 characters", () => {
    const long = "a".repeat(100);
    expect(slugifyEntity(long).length).toBeLessThanOrEqual(64);
  });

  test("returns _default for empty string", () => {
    expect(slugifyEntity("")).toBe("_default");
  });

  test("guards against path traversal", () => {
    expect(slugifyEntity("../etc")).toBe("etc");
    expect(slugifyEntity("../../passwd")).toBe("passwd");
    expect(slugifyEntity("..")).toBe("_default");
  });

  test("guards against absolute paths", () => {
    expect(slugifyEntity("/etc/passwd")).toBe("etc-passwd");
  });

  test("handles unicode characters", () => {
    // Non-alphanumeric unicode → dashes
    expect(slugifyEntity("café")).toBe("caf");
    expect(slugifyEntity("日本語")).toBe("_default");
  });

  test("handles dots only", () => {
    expect(slugifyEntity(".")).toBe("_default");
    expect(slugifyEntity("...")).toBe("_default");
  });

  test("preserves hyphens", () => {
    expect(slugifyEntity("my-entity")).toBe("my-entity");
  });

  test("handles all-whitespace input", () => {
    expect(slugifyEntity("   ")).toBe("_default");
  });
});
