import { describe, expect, test } from "bun:test";

import { checkAuth, constantTimeEquals } from "./auth.js";

function reqWith(headers: Readonly<Record<string, string>>): Request {
  return new Request("http://localhost/agents", { headers });
}

describe("checkAuth", () => {
  test("returns ok when token matches", () => {
    expect(checkAuth(reqWith({ authorization: "Bearer s3cret" }), "s3cret")).toBe("ok");
  });

  test("returns invalid when token differs", () => {
    expect(checkAuth(reqWith({ authorization: "Bearer wrong" }), "s3cret")).toBe("invalid");
  });

  test("returns missing when header is absent", () => {
    expect(checkAuth(reqWith({}), "s3cret")).toBe("missing");
  });

  test("returns missing when header lacks Bearer prefix", () => {
    expect(checkAuth(reqWith({ authorization: "Basic abc" }), "s3cret")).toBe("missing");
  });

  test("returns missing when bearer value is empty", () => {
    expect(checkAuth(reqWith({ authorization: "Bearer " }), "s3cret")).toBe("missing");
  });

  test("returns unconfigured when expected token is empty", () => {
    expect(checkAuth(reqWith({ authorization: "Bearer x" }), "")).toBe("unconfigured");
  });

  test("returns unconfigured when expected token is undefined at runtime", () => {
    // TS types declare string, but `process.env.X` is `string | undefined`
    // so callers may pass undefined despite the type. Must not throw.
    const undef = undefined as unknown as string;
    expect(checkAuth(reqWith({ authorization: "Bearer x" }), undef)).toBe("unconfigured");
  });

  test("returns unconfigured when expected token is non-string at runtime", () => {
    const num = 42 as unknown as string;
    expect(checkAuth(reqWith({ authorization: "Bearer x" }), num)).toBe("unconfigured");
  });

  test("token comparison is independent of length when mismatched", () => {
    // Different lengths still produce 'invalid', not throw.
    expect(checkAuth(reqWith({ authorization: "Bearer short" }), "muchlonger")).toBe("invalid");
  });
});

describe("constantTimeEquals", () => {
  test("returns true for identical strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });

  test("returns false for different strings of equal length", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });

  test("returns false for differing lengths", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });

  test("handles empty strings", () => {
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("", "x")).toBe(false);
  });
});
