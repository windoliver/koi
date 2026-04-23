import { describe, expect, test } from "bun:test";
import { mergeSettings } from "./merge.js";
import type { KoiSettings } from "./types.js";

describe("mergeSettings", () => {
  test("empty layers returns empty settings", () => {
    expect(mergeSettings([])).toEqual({});
  });

  test("single layer returns that layer unchanged", () => {
    const layer: KoiSettings = { theme: "dark" };
    expect(mergeSettings([layer])).toEqual({ theme: "dark" });
  });

  test("scalars: later layer wins", () => {
    const result = mergeSettings([{ theme: "dark" }, { theme: "light" }]);
    expect(result.theme).toBe("light");
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

  test("objects: env deep-merged, later key wins", () => {
    const a: KoiSettings = { env: { LOG: "info", PORT: "3000" } };
    const b: KoiSettings = { env: { LOG: "debug", HOST: "localhost" } };
    const result = mergeSettings([a, b]);
    expect(result.env).toEqual({ LOG: "debug", PORT: "3000", HOST: "localhost" });
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

  test("policy scalar overrides merged scalar", () => {
    const result = mergeSettings([{ theme: "dark" }], { theme: "light" });
    expect(result.theme).toBe("light");
  });

  test("missing layer (undefined) is skipped", () => {
    const result = mergeSettings([undefined, { theme: "dark" }, undefined]);
    expect(result.theme).toBe("dark");
  });
});
