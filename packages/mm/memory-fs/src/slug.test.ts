import { describe, expect, test } from "bun:test";
import { deriveFilename, slugifyMemoryName } from "./slug.js";

describe("slugifyMemoryName", () => {
  test("lowercases input", () => {
    expect(slugifyMemoryName("UserRole")).toBe("userrole");
  });

  test("replaces spaces with underscores", () => {
    expect(slugifyMemoryName("user role")).toBe("user_role");
  });

  test("replaces special characters with underscores", () => {
    expect(slugifyMemoryName("user@role!")).toBe("user_role");
  });

  test("collapses consecutive underscores", () => {
    expect(slugifyMemoryName("user   role")).toBe("user_role");
  });

  test("trims leading and trailing underscores", () => {
    expect(slugifyMemoryName("  user role  ")).toBe("user_role");
  });

  test("preserves hyphens", () => {
    expect(slugifyMemoryName("user-role")).toBe("user-role");
  });

  test("truncates to 64 characters", () => {
    const long = "a".repeat(100);
    expect(slugifyMemoryName(long).length).toBeLessThanOrEqual(64);
  });

  test("returns _memory for empty string", () => {
    expect(slugifyMemoryName("")).toBe("_memory");
  });

  test("returns _memory for whitespace-only", () => {
    expect(slugifyMemoryName("   ")).toBe("_memory");
  });

  test("guards against path traversal ..", () => {
    expect(slugifyMemoryName("..")).toBe("_memory");
  });

  test("guards against single dot", () => {
    expect(slugifyMemoryName(".")).toBe("_memory");
  });

  test("handles all-special-character input", () => {
    expect(slugifyMemoryName("@#$%")).toBe("_memory");
  });
});

describe("deriveFilename", () => {
  test("returns slug.md when no collision", () => {
    expect(deriveFilename("user role", new Set())).toBe("user_role.md");
  });

  test("appends -2 on first collision", () => {
    expect(deriveFilename("user role", new Set(["user_role.md"]))).toBe("user_role-2.md");
  });

  test("appends -3 when -2 also exists", () => {
    const existing = new Set(["user_role.md", "user_role-2.md"]);
    expect(deriveFilename("user role", existing)).toBe("user_role-3.md");
  });
});
