import { describe, expect, test } from "bun:test";
import { BUILTIN_SPECS, createSpecRegistry, registerSpec } from "./registry.js";
import type { CommandSpec } from "./types.js";

const EXPECTED_BUILTINS: readonly string[] = [
  "rm",
  "cp",
  "mv",
  "chmod",
  "chown",
  "curl",
  "wget",
  "tar",
  "scp",
  "ssh",
];

describe("BUILTIN_SPECS", () => {
  test("contains exactly 10 entries", () => {
    expect(BUILTIN_SPECS.size).toBe(10);
  });

  test("contains exactly the expected command names", () => {
    expect([...BUILTIN_SPECS.keys()].sort()).toEqual([...EXPECTED_BUILTINS].sort());
  });

  test("each entry is callable and returns a SpecResult", () => {
    for (const [name, spec] of BUILTIN_SPECS) {
      const result = spec([name]);
      expect(["complete", "partial", "refused"]).toContain(result.kind);
    }
  });
});

describe("createSpecRegistry", () => {
  test("returns a Map seeded with all builtins", () => {
    const reg = createSpecRegistry();
    expect(reg.size).toBe(10);
    for (const name of EXPECTED_BUILTINS) {
      expect(reg.has(name)).toBe(true);
    }
  });

  test("returns a fresh mutable Map each call (no shared state)", () => {
    const a = createSpecRegistry();
    const b = createSpecRegistry();
    expect(a).not.toBe(b);
    const customSpec: CommandSpec = () => ({
      kind: "refused",
      cause: "parse-error",
      detail: "x",
    });
    a.set("custom", customSpec);
    expect(a.has("custom")).toBe(true);
    expect(b.has("custom")).toBe(false);
  });
});

describe("registerSpec", () => {
  test("adds an entry to the given registry", () => {
    const reg = createSpecRegistry();
    const myFn: CommandSpec = () => ({ kind: "refused", cause: "parse-error", detail: "x" });
    registerSpec(reg, "git", myFn);
    expect(reg.get("git")).toBe(myFn);
    expect(reg.size).toBe(11);
  });

  test("preserves existing builtins after register", () => {
    const reg = createSpecRegistry();
    const myFn: CommandSpec = () => ({ kind: "refused", cause: "parse-error", detail: "x" });
    registerSpec(reg, "git", myFn);
    expect(reg.get("rm")).toBeDefined();
  });
});
