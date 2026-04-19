import { describe, expect, test } from "bun:test";
import { specWget } from "./wget.js";

describe("specWget — http(s)", () => {
  test("plain wget → partial with wget-follows-redirects", () => {
    const result = specWget(["wget", "https://example.com/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("wget-follows-redirects");
    expect(result.semantics.network[0]?.host).toBe("example.com");
    expect(result.semantics.writes).toEqual([]);
  });

  test("with -O FILE → file in writes", () => {
    const result = specWget(["wget", "-O", "out.bin", "https://example.com/"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.writes).toEqual(["out.bin"]);
  });

  test("port preserved in host", () => {
    const result = specWget(["wget", "https://example.com:8443/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.network[0]?.host).toBe("example.com:8443");
  });
});

describe("specWget — ftp(s)", () => {
  test("ftp scheme", () => {
    const result = specWget(["wget", "ftp://files.example.com/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.network[0]?.kind).toBe("ftp");
  });
});

describe("specWget — refused", () => {
  test("file:// scheme refused", () => {
    expect(specWget(["wget", "file:///etc/passwd"]).kind).toBe("refused");
  });

  test("gopher:// scheme refused", () => {
    expect(specWget(["wget", "gopher://x"]).kind).toBe("refused");
  });

  test("malformed URL → parse-error", () => {
    const result = specWget(["wget", "http://[invalid"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("-i refused", () => {
    expect(specWget(["wget", "-i", "list.txt"]).kind).toBe("refused");
  });

  test("--input-file refused", () => {
    expect(specWget(["wget", "--input-file", "list.txt"]).kind).toBe("refused");
  });

  test("no URL", () => {
    expect(specWget(["wget"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specWget(["curl", "https://x"]).kind).toBe("refused");
  });
});
