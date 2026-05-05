import { describe, expect, test } from "bun:test";
import { computeJaccardDistance, tokenize } from "./divergence.js";

describe("tokenize", () => {
  test("lowercases, splits on non-word chars, drops short tokens and stopwords", () => {
    const tokens = tokenize("Read THE files from the filesystem.");
    expect([...tokens].sort()).toEqual(["files", "filesystem", "read"]);
  });

  test("returns empty set for empty input", () => {
    expect(tokenize("").size).toBe(0);
  });

  test("splits snake_case into individual words", () => {
    expect([...tokenize("read_file_contents")].sort()).toEqual(["contents", "file", "read"]);
  });

  test("splits camelCase into individual words", () => {
    expect([...tokenize("readFileContents")].sort()).toEqual(["contents", "file", "read"]);
  });

  test("splits PascalCase + acronyms cleanly", () => {
    expect([...tokenize("HTTPRequestHandler")].sort()).toEqual(["handler", "http", "request"]);
  });

  test("splits hyphenated identifiers", () => {
    expect([...tokenize("parse-json-config")].sort()).toEqual(["config", "json", "parse"]);
  });

  test("preserves 2-letter acronyms (db, ui, ml, ci)", () => {
    expect([...tokenize("db ui ml ci tool")].sort()).toEqual(["ci", "db", "ml", "tool", "ui"]);
  });

  test("drops common 2-letter English words (to, of, in, on, is, it)", () => {
    // These would silently reduce Jaccard divergence on ordinary prose.
    expect([...tokenize("to of in on is it at by tool")].sort()).toEqual(["tool"]);
  });

  test("drops digits-only tokens (timestamps, ports, HTTP codes)", () => {
    expect([...tokenize("status 200 port 8080 1730000000 tool")].sort()).toEqual([
      "port",
      "status",
      "tool",
    ]);
  });

  test("drops UUID-fragment / hex-digest tokens (no 3+ letter run)", () => {
    expect([...tokenize("trace a3f9c2 b00b1e5 f00b4r5 parser")].sort()).toEqual([
      "parser",
      "trace",
    ]);
  });

  test("keeps technical words containing digits when they have a real letter run", () => {
    expect([...tokenize("oauth2 sha256 utf8 parser")].sort()).toEqual([
      "oauth2",
      "parser",
      "sha256",
      "utf8",
    ]);
  });

  test("unrelated short prose still scores as fully divergent", () => {
    // Regression: when 2-char filler words slipped through, two semantically
    // unrelated short sentences could overlap on `to`, `of`, `is`, etc., and
    // produce divergence well below 1, masking real drift.
    const a = tokenize("read configuration files in the project root");
    const b = tokenize("send notifications to slack on incident");
    expect(computeJaccardDistance(a, b)).toBe(1);
  });

  test("snake_case and camelCase tokenize identically", () => {
    expect([...tokenize("parse_json_config")].sort()).toEqual(
      [...tokenize("parseJsonConfig")].sort(),
    );
  });
});

describe("computeJaccardDistance", () => {
  test("returns 0 when identical", () => {
    const a = tokenize("read files filesystem");
    const b = tokenize("read files filesystem");
    expect(computeJaccardDistance(a, b)).toBe(0);
  });

  test("returns 1 when fully disjoint", () => {
    const a = tokenize("alpha beta gamma");
    const b = tokenize("delta epsilon zeta");
    expect(computeJaccardDistance(a, b)).toBe(1);
  });

  test("returns NaN when either set is empty (no lexical signal)", () => {
    expect(computeJaccardDistance(new Set(), new Set())).toBeNaN();
    expect(computeJaccardDistance(new Set(["a", "b"]), new Set())).toBeNaN();
    expect(computeJaccardDistance(new Set(), new Set(["a", "b"]))).toBeNaN();
  });

  test("partial overlap is between 0 and 1", () => {
    const a = tokenize("read files config");
    const b = tokenize("read network packets");
    const d = computeJaccardDistance(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
});
