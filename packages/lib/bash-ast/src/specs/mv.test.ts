import { describe, expect, test } from "bun:test";
import { specMv } from "./mv.js";

describe("specMv — -T form (complete)", () => {
  test("two positionals with -T", () => {
    const result = specMv(["mv", "-T", "src", "dst"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["src", "dst"]);
    expect(result.semantics.reads).toEqual([]);
  });

  test("-T with !=2 positionals refused", () => {
    expect(specMv(["mv", "-T", "a"]).kind).toBe("refused");
    expect(specMv(["mv", "-T", "a", "b", "c"]).kind).toBe("refused");
  });
});

describe("specMv — -t DIR form (complete)", () => {
  test("derives DIR/basename for each src", () => {
    const result = specMv(["mv", "-t", "out", "a", "b/c"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["a", "b/c", "out/a", "out/c"]);
  });

  test("strips trailing slash from src", () => {
    const result = specMv(["mv", "-t", "out", "src/"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["src/", "out/src"]);
  });

  test("src that is / refuses", () => {
    const result = specMv(["mv", "-t", "out", "/"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });
});

describe("specMv — destination-last (partial)", () => {
  test("partial with cp-mv-dest-may-be-directory", () => {
    const result = specMv(["mv", "foo.txt", "out/dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("cp-mv-dest-may-be-directory");
    expect(result.semantics.writes).toEqual(["foo.txt", "out/dir", "out/dir/foo.txt"]);
  });

  test("multiple srcs over-approximated", () => {
    const result = specMv(["mv", "a", "b", "out"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.writes).toEqual(["a", "b", "out", "out/a", "out/b"]);
  });
});

describe("specMv — refused", () => {
  test("zero positionals", () => {
    expect(specMv(["mv"]).kind).toBe("refused");
  });

  test("one positional (no destination)", () => {
    expect(specMv(["mv", "src"]).kind).toBe("refused");
  });

  test("unknown flag", () => {
    expect(specMv(["mv", "-z", "a", "b"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specMv(["cp", "a", "b"]).kind).toBe("refused");
  });
});
