import { describe, expect, test } from "bun:test";
import { specCp } from "./cp.js";

describe("specCp — -T form (complete)", () => {
  test("two positionals with -T", () => {
    const result = specCp(["cp", "-T", "src", "dst"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["src"]);
    expect(result.semantics.writes).toEqual(["dst"]);
  });

  test("-T with !=2 positionals refused", () => {
    expect(specCp(["cp", "-T", "a"]).kind).toBe("refused");
    expect(specCp(["cp", "-T", "a", "b", "c"]).kind).toBe("refused");
  });

  test("conflicting -T and -t DIR refused (regression)", () => {
    const result = specCp(["cp", "-T", "-t", "/restricted", "src", "dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
    expect(result.detail).toMatch(/mutually exclusive/);
  });
});

describe("specCp — -t DIR form (complete)", () => {
  test("derives DIR/basename for each src", () => {
    const result = specCp(["cp", "-t", "out", "a", "b"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["a", "b"]);
    expect(result.semantics.writes).toEqual(["out/a", "out/b"]);
  });

  test("strips trailing slash on src basename", () => {
    const result = specCp(["cp", "-t", "out", "src/"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out/src"]);
  });

  test("normalizes trailing slash on destination prefix", () => {
    const result = specCp(["cp", "-t", "out/", "a"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out/a"]);
  });

  test("src that is / refuses", () => {
    const result = specCp(["cp", "-t", "out", "/"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });
});

describe("specCp — destination-last (partial)", () => {
  test("partial with cp-mv-dest-may-be-directory and over-approx writes", () => {
    const result = specCp(["cp", "foo.txt", "out/dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("cp-mv-dest-may-be-directory");
    expect(result.semantics.reads).toEqual(["foo.txt"]);
    expect(result.semantics.writes).toEqual(["out/dir", "out/dir/foo.txt"]);
  });

  test("multiple sources", () => {
    const result = specCp(["cp", "a", "b", "out"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.reads).toEqual(["a", "b"]);
    expect(result.semantics.writes).toEqual(["out", "out/a", "out/b"]);
  });

  test("normalizes trailing slash when deriving destination-last basenames", () => {
    const result = specCp(["cp", "a", "out/"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.writes).toEqual(["out/", "out/a"]);
  });
});

describe("specCp — recursive interaction", () => {
  test("-r alone with destination-last → partial; reason joins both", () => {
    const result = specCp(["cp", "-r", "src", "dst"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root;cp-mv-dest-may-be-directory");
  });

  test("-R with -T → partial recursive-subtree-root only", () => {
    const result = specCp(["cp", "-R", "-T", "src", "dst"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.reads).toEqual(["src"]);
    expect(result.semantics.writes).toEqual(["dst"]);
  });

  test("-a with -t → partial recursive-subtree-root only", () => {
    const result = specCp(["cp", "-a", "-t", "out", "a"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["out/a"]);
  });
});

describe("specCp — refused", () => {
  test("zero positionals", () => {
    expect(specCp(["cp"]).kind).toBe("refused");
  });

  test("one positional", () => {
    expect(specCp(["cp", "src"]).kind).toBe("refused");
  });

  test("unknown flag", () => {
    expect(specCp(["cp", "-z", "a", "b"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specCp(["mv", "a", "b"]).kind).toBe("refused");
  });
});
