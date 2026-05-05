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

  test("CJK text produces tokens (ASCII-only split was a silent observation drop)", () => {
    // Regression: the old [A-Za-z0-9] split returned empty segments for
    // non-Latin scripts, so computeJaccardDistance(...) returned NaN and the
    // detector dropped the whole observation. Unicode-aware split keeps the
    // tokens.
    expect([...tokenize("工具读取配置")]).toEqual(["工具读取配置"]);
    const tokens = tokenize("工具 读取 配置");
    expect(tokens.size).toBe(3);
    expect(tokens.has("工具")).toBe(true);
    expect(tokens.has("读取")).toBe(true);
    expect(tokens.has("配置")).toBe(true);
  });

  test("Cyrillic and Arabic tokens survive", () => {
    const ru = tokenize("читать файл");
    expect(ru.size).toBe(2);
    expect(ru.has("читать")).toBe(true);
    expect(ru.has("файл")).toBe(true);
    const ar = tokenize("قراءة الملف");
    expect(ar.size).toBe(2);
    expect(ar.has("قراءة")).toBe(true);
    expect(ar.has("الملف")).toBe(true);
  });

  test("non-ASCII tokens of length 2 survive (no English-stopword equivalent)", () => {
    // 2-letter ASCII tokens go through TWO_LETTER_ALLOWLIST; CJK 2-char words
    // are normal morphemes and must not be filtered by that English-specific
    // rule.
    const t = tokenize("工具 配置");
    expect(t.size).toBe(2);
    expect(t.has("工具")).toBe(true);
    expect(t.has("配置")).toBe(true);
  });

  test("Unicode-only descriptions are NOT fully disjoint from themselves", () => {
    // Regression of the silent-drop bug: same CJK string against itself must
    // give Jaccard distance 0, not NaN.
    const a = tokenize("工具读取配置文件");
    const b = tokenize("工具读取配置文件");
    expect(computeJaccardDistance(a, b)).toBe(0);
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
