import { describe, expect, test } from "bun:test";
import { specRm } from "./rm.js";

describe("specRm — non-recursive", () => {
  test("returns complete with all positionals as writes", () => {
    const result = specRm(["rm", "a", "b", "c"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["a", "b", "c"]);
    expect(result.semantics.reads).toEqual([]);
    expect(result.semantics.network).toEqual([]);
    expect(result.semantics.envMutations).toEqual([]);
  });

  test("recognises -f and -i and -v as bool flags", () => {
    const result = specRm(["rm", "-f", "-i", "-v", "x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["x"]);
  });

  test("treats -- as end-of-options", () => {
    const result = specRm(["rm", "-f", "--", "-x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["-x"]);
  });
});

describe("specRm — recursive (partial)", () => {
  test("with -r returns partial recursive-subtree-root", () => {
    const result = specRm(["rm", "-r", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["dir"]);
  });

  test("with -R returns partial recursive-subtree-root", () => {
    const result = specRm(["rm", "-R", "dir"]);
    expect(result.kind).toBe("partial");
  });

  test("with -d returns partial recursive-subtree-root", () => {
    const result = specRm(["rm", "-d", "dir"]);
    expect(result.kind).toBe("partial");
  });

  test("bundled -rf returns partial", () => {
    const result = specRm(["rm", "-rf", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.writes).toEqual(["dir"]);
  });
});

describe("specRm — refused", () => {
  test("missing positional returns parse-error", () => {
    const result = specRm(["rm"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("unknown flag returns parse-error", () => {
    const result = specRm(["rm", "-z", "x"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("dispatched on wrong command name returns parse-error", () => {
    const result = specRm(["ls", "x"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("REJECTS path-qualified /bin/rm (consumer must canonicalize and pass bare name)", () => {
    const result = specRm(["/bin/rm", "foo"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("REJECTS relative path-qualified ./rm (likely wrapper)", () => {
    const result = specRm(["./rm", "foo"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });
});
