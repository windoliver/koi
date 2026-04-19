import { describe, expect, test } from "bun:test";
import { specCurl } from "./curl.js";

describe("specCurl — http(s)", () => {
  test("plain GET → complete network http", () => {
    const result = specCurl(["curl", "https://example.com/path"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const n = result.semantics.network[0];
    expect(n).toBeDefined();
    if (!n) return;
    expect(n.kind).toBe("http");
    expect(n.target).toBe("https://example.com/path");
    expect(n.host).toBe("example.com");
  });

  test("non-default port preserved in host", () => {
    const result = specCurl(["curl", "https://example.com:8443/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.network[0]?.host).toBe("example.com:8443");
  });

  test("with -o FILE → file in writes", () => {
    const result = specCurl(["curl", "-o", "out.bin", "https://example.com/"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.bin"]);
  });

  test("with -L sets partial curl-follows-redirects", () => {
    const result = specCurl(["curl", "-L", "https://example.com/"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("curl-follows-redirects");
  });

  test("with -O sets partial curl-O-derived-basename", () => {
    const result = specCurl(["curl", "-O", "https://example.com/x.tar"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("curl-O-derived-basename");
    expect(result.semantics.writes).toEqual([]);
  });

  test("-L and -O combine reasons joined by ;", () => {
    const result = specCurl(["curl", "-L", "-O", "https://example.com/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("curl-follows-redirects;curl-O-derived-basename");
  });

  test("with -d @file → file in reads", () => {
    const result = specCurl(["curl", "-d", "@body.json", "https://api/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["body.json"]);
  });

  test("inline -d data does NOT produce a read", () => {
    const result = specCurl(["curl", "-d", "key=val", "https://api/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual([]);
  });
});

describe("specCurl — ftp(s)", () => {
  test("ftp scheme → network kind ftp", () => {
    const result = specCurl(["curl", "ftp://files.example.com/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.network[0]?.kind).toBe("ftp");
  });
});

describe("specCurl — file://", () => {
  test("file:///path → reads [path], no network", () => {
    const result = specCurl(["curl", "file:///etc/passwd"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["/etc/passwd"]);
    expect(result.semantics.network).toEqual([]);
  });

  test("file://host/path → refused unsupported-form (non-empty authority)", () => {
    const result = specCurl(["curl", "file://host/path"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
  });
});

describe("specCurl — refused schemes", () => {
  test("scp://", () => {
    const result = specCurl(["curl", "scp://host/path"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
  });

  test("sftp://", () => {
    expect(specCurl(["curl", "sftp://host/p"]).kind).toBe("refused");
  });

  test("gopher:// → unsupported-form", () => {
    const result = specCurl(["curl", "gopher://host/x"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
  });
});

describe("specCurl — refused flags / parse errors", () => {
  test("--config refused", () => {
    expect(specCurl(["curl", "--config", "/tmp/c", "https://x"]).kind).toBe("refused");
  });

  test("-K refused", () => {
    expect(specCurl(["curl", "-K", "/tmp/c", "https://x"]).kind).toBe("refused");
  });

  test("--next refused", () => {
    expect(specCurl(["curl", "--next", "https://x"]).kind).toBe("refused");
  });

  test("-T refused", () => {
    expect(specCurl(["curl", "-T", "f", "https://x"]).kind).toBe("refused");
  });

  test("malformed URL → parse-error", () => {
    const result = specCurl(["curl", "http://[invalid"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("no URL positional", () => {
    expect(specCurl(["curl"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specCurl(["wget", "https://x"]).kind).toBe("refused");
  });
});
