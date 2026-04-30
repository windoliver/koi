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

  test("XFF rightmost untrusted (nearest non-proxy hop) is selected", () => {
    // Walk right-to-left so an attacker prepending headers at the leftmost
    // position cannot spoof the source. "5.6.7.8" is attacker-supplied,
    // "1.2.3.4" is the real client added by the outermost trusted proxy.
    const req = new Request("http://x/", {
      headers: { "X-Forwarded-For": "5.6.7.8, 1.2.3.4, 10.0.0.99" },
    });
    expect(
      resolveSourceId(req, "10.0.0.99", { mode: "trusted", trustedProxies: ["10.0.0.0/8"] }),
    ).toBe("1.2.3.4");
  });

  test("ignores attacker-prepended XFF entries (spoof defense)", () => {
    const req = new Request("http://x/", {
      headers: {
        "X-Forwarded-For": "10.0.0.5, 10.0.0.6, 1.2.3.4, 10.0.0.99",
      },
    });
    // Real client is "1.2.3.4"; "10.0.0.5/6" are attacker-supplied entries
    // that happen to fall in the trusted CIDR. Right-to-left walk skips the
    // trailing trusted proxies and stops at the first untrusted hop.
    expect(
      resolveSourceId(req, "10.0.0.99", { mode: "trusted", trustedProxies: ["10.0.0.0/8"] }),
    ).toBe("1.2.3.4");
  });
});
