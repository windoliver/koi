import { describe, expect, test } from "bun:test";
import { specTar } from "./tar.js";

describe("specTar — create (-c)", () => {
  test("returns complete with archive in writes and files in reads", () => {
    const result = specTar(["tar", "-c", "-f", "out.tar", "a.txt", "b.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
    expect(result.semantics.reads).toEqual(["a.txt", "b.txt"]);
  });

  test("bundled -cf works", () => {
    const result = specTar(["tar", "-cf", "out.tar", "a.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
  });

  test("attached -fFILE form (no space) works (regression)", () => {
    const result = specTar(["tar", "-c", "-fout.tar", "a.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
    expect(result.semantics.reads).toEqual(["a.txt"]);
  });

  test("attached bundle -cfFILE form (no space) works (regression)", () => {
    const result = specTar(["tar", "-cfout.tar", "a.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
    expect(result.semantics.reads).toEqual(["a.txt"]);
  });

  test("attached -CDIR form is recognized but refuses in -c mode (order-sensitive)", () => {
    const result = specTar(["tar", "-c", "-Cwork", "-fout.tar", "a.txt"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
    expect(result.detail).toMatch(/-C DIR/);
  });

  test("-C with -c refuses (order-sensitive operand rebase)", () => {
    const result = specTar(["tar", "-c", "-C", "/etc", "-f", "out.tar", "passwd"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("-C with -t refuses (order-sensitive operand rebase)", () => {
    const result = specTar(["tar", "-t", "-C", "/etc", "-f", "in.tar"]);
    expect(result.kind).toBe("refused");
  });

  test("archive flag interleaved with files (regression: positional-independence)", () => {
    const result = specTar(["tar", "-c", "a.txt", "-f", "out.tar", "b.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
    expect(result.semantics.reads).toEqual(["a.txt", "b.txt"]);
  });

  test("archive flag before mode flag (regression)", () => {
    const result = specTar(["tar", "-f", "out.tar", "-c", "a.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
    expect(result.semantics.reads).toEqual(["a.txt"]);
  });
});

describe("specTar — list (-t)", () => {
  test("returns complete with archive in reads, no writes", () => {
    const result = specTar(["tar", "-tf", "in.tar"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["in.tar"]);
    expect(result.semantics.writes).toEqual([]);
  });
});

describe("specTar — extract (-x, partial)", () => {
  test("returns partial with archive in reads and empty writes", () => {
    const result = specTar(["tar", "-xf", "in.tar"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("tar-extract-targets-in-archive");
    expect(result.semantics.reads).toEqual(["in.tar"]);
    expect(result.semantics.writes).toEqual([]);
  });

  test("with -C DIR — archive still in reads, writes empty", () => {
    const result = specTar(["tar", "-x", "-f", "in.tar", "-C", "/dest"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.reads).toEqual(["in.tar"]);
    expect(result.semantics.writes).toEqual([]);
  });
});

describe("specTar — refused", () => {
  test("multiple mode flags", () => {
    const result = specTar(["tar", "-c", "-x", "-f", "in.tar"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("no mode flag", () => {
    const result = specTar(["tar", "-f", "in.tar"]);
    expect(result.kind).toBe("refused");
  });

  test("no -f (stdin form)", () => {
    const result = specTar(["tar", "-c"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("-z is recognised (gzip), not refused", () => {
    expect(specTar(["tar", "-c", "-z", "-f", "x.tar"]).kind).not.toBe("refused");
  });

  test("truly unknown flag refused", () => {
    expect(specTar(["tar", "-c", "-Q", "-f", "x.tar"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specTar(["zip", "-c", "-f", "x"]).kind).toBe("refused");
  });
});
