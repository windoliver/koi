import { describe, expect, test } from "bun:test";
import { resolveSourceId } from "./source-id.js";

describe("resolveSourceId", () => {
  test("uses socket address when proxyTrust=none", () => {
    const req = new Request("http://x/", { headers: { "X-Forwarded-For": "1.2.3.4" } });
    expect(resolveSourceId(req, "10.0.0.1", { mode: "none" })).toBe("10.0.0.1");
  });

  test("trusts XFF only when socket is in trustedProxies", () => {
    const req = new Request("http://x/", { headers: { "X-Forwarded-For": "1.2.3.4, 10.0.0.99" } });
    expect(
      resolveSourceId(req, "10.0.0.99", { mode: "trusted", trustedProxies: ["10.0.0.0/8"] }),
    ).toBe("1.2.3.4");
  });

  test("ignores XFF if socket not in trustedProxies", () => {
    const req = new Request("http://x/", { headers: { "X-Forwarded-For": "1.2.3.4" } });
    expect(
      resolveSourceId(req, "203.0.113.1", { mode: "trusted", trustedProxies: ["10.0.0.0/8"] }),
    ).toBe("203.0.113.1");
  });

  test("XFF leftmost untrusted is selected", () => {
    const req = new Request("http://x/", {
      headers: { "X-Forwarded-For": "5.6.7.8, 1.2.3.4, 10.0.0.99" },
    });
    expect(
      resolveSourceId(req, "10.0.0.99", { mode: "trusted", trustedProxies: ["10.0.0.0/8"] }),
    ).toBe("5.6.7.8");
  });
});
