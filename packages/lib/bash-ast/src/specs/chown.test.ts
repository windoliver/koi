import { describe, expect, test } from "bun:test";
import { specChown } from "./chown.js";

describe("specChown — non-recursive", () => {
  test("returns complete with paths as writes (owner excluded)", () => {
    const result = specChown(["chown", "alice:wheel", "foo", "bar"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["foo", "bar"]);
    expect(result.semantics.network).toEqual([]);
    expect(result.semantics.envMutations).toEqual([]);
  });

  test("recognises -f and -v as bool flags", () => {
    const result = specChown(["chown", "-f", "-v", "alice", "x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["x"]);
  });

  test("treats -- as end-of-options", () => {
    const result = specChown(["chown", "--", "root", "-x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["-x"]);
  });
});

describe("specChown — recursive (partial)", () => {
  test("with -R returns partial recursive-subtree-root", () => {
    const result = specChown(["chown", "-R", "alice", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["dir"]);
  });
});

describe("specChown — refused", () => {
  test("missing both", () => {
    expect(specChown(["chown"]).kind).toBe("refused");
  });

  test("missing path", () => {
    expect(specChown(["chown", "alice"]).kind).toBe("refused");
  });

  test("unknown flag", () => {
    expect(specChown(["chown", "-z", "alice", "x"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specChown(["ls", "alice", "x"]).kind).toBe("refused");
  });
});
