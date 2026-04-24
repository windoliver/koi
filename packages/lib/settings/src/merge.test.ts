import { describe, expect, test } from "bun:test";
import { mergeSettings } from "./merge.js";
import type { KoiSettings } from "./types.js";

describe("mergeSettings", () => {
  test("empty layers returns empty settings", () => {
    expect(mergeSettings([])).toEqual({});
  });

  test("single layer returns that layer unchanged", () => {
    const layer: KoiSettings = { permissions: { defaultMode: "default" } };
    expect(mergeSettings([layer])).toEqual({ permissions: { defaultMode: "default" } });
  });

  test("scalars: later layer wins", () => {
    const result = mergeSettings([
      { permissions: { allow: ["fs_read(*)"] } },
      { permissions: { defaultMode: "default" } },
    ]);
    expect(result.permissions?.defaultMode).toBe("default");
  });

  test("arrays: concatenated and deduplicated", () => {
    const a: KoiSettings = { permissions: { allow: ["Read(*)", "Glob(*)"] } };
    const b: KoiSettings = { permissions: { allow: ["Glob(*)", "Bash(git *)"] } };
    const result = mergeSettings([a, b]);
    expect(result.permissions?.allow).toEqual(["Read(*)", "Glob(*)", "Bash(git *)"]);
  });

  test("arrays: deny from multiple layers all collected", () => {
    const a: KoiSettings = { permissions: { deny: ["Bash(rm *)"] } };
    const b: KoiSettings = { permissions: { deny: ["WebFetch(*)"] } };
    const result = mergeSettings([a, b]);
    expect(result.permissions?.deny).toEqual(["Bash(rm *)", "WebFetch(*)"]);
  });

  test("policy tightening: policy deny removes from merged allow", () => {
    const merged: KoiSettings = {
      permissions: { allow: ["Bash(git *)", "Read(*)"] },
    };
    const policy: KoiSettings = {
      permissions: { deny: ["Bash(*)"] },
    };
    const result = mergeSettings([merged], policy);
    expect(result.permissions?.allow).not.toContain("Bash(git *)");
    expect(result.permissions?.deny).toContain("Bash(*)");
  });

  test("policy tightening: policy deny removes from merged ask", () => {
    const merged: KoiSettings = {
      permissions: { ask: ["Bash(git push*)"] },
    };
    const policy: KoiSettings = {
      permissions: { deny: ["Bash(*)"] },
    };
    const result = mergeSettings([merged], policy);
    expect(result.permissions?.ask).not.toContain("Bash(git push*)");
  });

  test("policy tightening: Tool(*) deny subsumes bare Tool allow entry", () => {
    const merged: KoiSettings = {
      permissions: { allow: ["Bash"] },
    };
    const policy: KoiSettings = {
      permissions: { deny: ["Bash(*)"] },
    };
    const result = mergeSettings([merged], policy);
    expect(result.permissions?.allow).not.toContain("Bash");
    expect(result.permissions?.deny).toContain("Bash(*)");
  });

  test("policy tightening: bare Tool deny subsumes command-scoped allow entry", () => {
    const merged: KoiSettings = {
      permissions: { allow: ["Bash(git *)"] },
    };
    const policy: KoiSettings = {
      permissions: { deny: ["Bash"] },
    };
    const result = mergeSettings([merged], policy);
    expect(result.permissions?.allow).not.toContain("Bash(git *)");
    expect(result.permissions?.deny).toContain("Bash");
  });

  test("policy tightening: command-scoped deny does NOT subsume bare Tool allow", () => {
    const merged: KoiSettings = {
      permissions: { allow: ["Bash"] },
    };
    const policy: KoiSettings = {
      permissions: { deny: ["Bash(rm -rf*)"] },
    };
    const result = mergeSettings([merged], policy);
    // Bare "Bash" is a broader entry; a narrow command-scoped deny doesn't remove it
    expect(result.permissions?.allow).toContain("Bash");
  });

  test("missing layer (undefined) is skipped", () => {
    const result = mergeSettings([
      undefined,
      { permissions: { defaultMode: "default" } },
      undefined,
    ]);
    expect(result.permissions?.defaultMode).toBe("default");
  });
});
