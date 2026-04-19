import { describe, expect, test } from "bun:test";
import { BUILTIN_SPECS, createSpecRegistry, lookupSpec, registerSpec } from "./registry.js";
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

  test("BUILTIN_SPECS is immutable at runtime — set/delete/clear throw", () => {
    const noop: CommandSpec = () => ({ kind: "refused", cause: "parse-error", detail: "x" });
    // Simulate a JS caller (or TS caller bypassing the ReadonlyMap type)
    // attempting to mutate the singleton.
    expect(() => {
      // @ts-expect-error — set() is not on ReadonlyMap; we're proving the runtime guard.
      BUILTIN_SPECS.set("git", noop);
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error — delete() is not on ReadonlyMap; we're proving the runtime guard.
      BUILTIN_SPECS.delete("rm");
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error — clear() is not on ReadonlyMap; we're proving the runtime guard.
      BUILTIN_SPECS.clear();
    }).toThrow(TypeError);
    // After all that, the table is unchanged.
    expect(BUILTIN_SPECS.size).toBe(10);
    expect(BUILTIN_SPECS.has("rm")).toBe(true);
    expect(BUILTIN_SPECS.has("git")).toBe(false);
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

describe("lookupSpec", () => {
  test("matches bare command name", () => {
    expect(lookupSpec(BUILTIN_SPECS, "rm")).toBeDefined();
  });

  test("matches absolute path-qualified command (regression)", () => {
    expect(lookupSpec(BUILTIN_SPECS, "/bin/rm")).toBeDefined();
    expect(lookupSpec(BUILTIN_SPECS, "/usr/local/bin/curl")).toBeDefined();
  });

  test("matches relative path-qualified command", () => {
    expect(lookupSpec(BUILTIN_SPECS, "./bin/tar")).toBeDefined();
  });

  test("returns the SAME function whether bare or path-qualified", () => {
    expect(lookupSpec(BUILTIN_SPECS, "/bin/rm")).toBe(lookupSpec(BUILTIN_SPECS, "rm"));
  });

  test("returns undefined for unregistered command", () => {
    expect(lookupSpec(BUILTIN_SPECS, "git")).toBeUndefined();
  });

  test("returns undefined for argv0 = '/' (no basename)", () => {
    expect(lookupSpec(BUILTIN_SPECS, "/")).toBeUndefined();
  });

  test("returns undefined for argv0 = undefined", () => {
    expect(lookupSpec(BUILTIN_SPECS, undefined)).toBeUndefined();
  });
});
