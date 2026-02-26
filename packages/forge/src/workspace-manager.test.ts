/**
 * Tests for workspace manager — unit tests with mocked I/O.
 */

import { describe, expect, test } from "bun:test";
import { computeDependencyHash, resolveWorkspacePath } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// computeDependencyHash
// ---------------------------------------------------------------------------

describe("computeDependencyHash", () => {
  test("returns a 64-char hex string", () => {
    const hash = computeDependencyHash({ zod: "3.22.0" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for same input", () => {
    const a = computeDependencyHash({ zod: "3.22.0", lodash: "4.17.21" });
    const b = computeDependencyHash({ zod: "3.22.0", lodash: "4.17.21" });
    expect(a).toBe(b);
  });

  test("is order-independent (sorted keys)", () => {
    const a = computeDependencyHash({ zod: "3.22.0", lodash: "4.17.21" });
    const b = computeDependencyHash({ lodash: "4.17.21", zod: "3.22.0" });
    expect(a).toBe(b);
  });

  test("different versions produce different hashes", () => {
    const a = computeDependencyHash({ zod: "3.22.0" });
    const b = computeDependencyHash({ zod: "3.23.0" });
    expect(a).not.toBe(b);
  });

  test("different packages produce different hashes", () => {
    const a = computeDependencyHash({ zod: "3.22.0" });
    const b = computeDependencyHash({ lodash: "3.22.0" });
    expect(a).not.toBe(b);
  });

  test("handles empty object", () => {
    const hash = computeDependencyHash({});
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("handles scoped package names", () => {
    const hash = computeDependencyHash({ "@types/node": "20.0.0" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe("resolveWorkspacePath", () => {
  test("uses provided cacheDir", () => {
    const path = resolveWorkspacePath("abc123", "/tmp/test-cache");
    expect(path).toBe("/tmp/test-cache/abc123");
  });

  test("appends depHash to cacheDir", () => {
    const hash = "deadbeef";
    const path = resolveWorkspacePath(hash, "/my/cache");
    expect(path).toEndWith(`/${hash}`);
  });

  test("falls back to XDG default when no cacheDir provided", () => {
    const path = resolveWorkspacePath("abc123");
    expect(path).toContain("koi/brick-workspaces/abc123");
  });
});
