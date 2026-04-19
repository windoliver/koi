import { describe, expect, test } from "bun:test";
import { specChmod } from "./chmod.js";

describe("specChmod — non-recursive", () => {
  test("returns complete with paths as writes (mode excluded)", () => {
    const result = specChmod(["chmod", "755", "foo", "bar"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["foo", "bar"]);
    expect(result.semantics.reads).toEqual([]);
    expect(result.semantics.network).toEqual([]);
    expect(result.semantics.envMutations).toEqual([]);
  });

  test("recognises -f and -v", () => {
    const result = specChmod(["chmod", "-f", "-v", "+x", "x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["x"]);
  });

  test("treats -- as end-of-options", () => {
    const result = specChmod(["chmod", "--", "755", "-x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["-x"]);
  });
});

describe("specChmod — recursive (partial)", () => {
  test("with -R returns partial recursive-subtree-root", () => {
    const result = specChmod(["chmod", "-R", "755", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["dir"]);
  });
});

describe("specChmod — refused", () => {
  test("missing mode and path", () => {
    expect(specChmod(["chmod"]).kind).toBe("refused");
  });

  test("missing path (only mode)", () => {
    const result = specChmod(["chmod", "755"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("unknown flag", () => {
    expect(specChmod(["chmod", "-z", "755", "x"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specChmod(["ls", "755", "x"]).kind).toBe("refused");
  });
});
