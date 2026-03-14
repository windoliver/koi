import { describe, expect, test } from "bun:test";
import { isBlockedIp, isBlockedUrl } from "./url-policy.js";

// ---------------------------------------------------------------------------
// isBlockedUrl (string-based first pass)
// ---------------------------------------------------------------------------

describe("isBlockedUrl", () => {
  test("blocks localhost", () => {
    expect(isBlockedUrl("http://localhost/admin")).toBe(true);
    expect(isBlockedUrl("https://localhost:8080/")).toBe(true);
    expect(isBlockedUrl("http://localhost")).toBe(true);
  });

  test("blocks loopback addresses", () => {
    expect(isBlockedUrl("http://127.0.0.1/")).toBe(true);
    expect(isBlockedUrl("http://127.0.0.1:3000/api")).toBe(true);
    expect(isBlockedUrl("http://127.255.255.255/")).toBe(true);
  });

  test("blocks private 10.x.x.x range", () => {
    expect(isBlockedUrl("http://10.0.0.1/")).toBe(true);
    expect(isBlockedUrl("http://10.255.255.255:80/")).toBe(true);
  });

  test("blocks private 172.16-31.x.x range", () => {
    expect(isBlockedUrl("http://172.16.0.1/")).toBe(true);
    expect(isBlockedUrl("http://172.31.255.255/")).toBe(true);
    // 172.15 and 172.32 are NOT private
    expect(isBlockedUrl("http://172.15.0.1/")).toBe(false);
    expect(isBlockedUrl("http://172.32.0.1/")).toBe(false);
  });

  test("blocks private 192.168.x.x range", () => {
    expect(isBlockedUrl("http://192.168.1.1/")).toBe(true);
    expect(isBlockedUrl("http://192.168.0.100:8080")).toBe(true);
  });

  test("blocks AWS/cloud metadata endpoint", () => {
    expect(isBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(isBlockedUrl("http://169.254.0.1/")).toBe(true);
  });

  test("blocks IPv6 loopback", () => {
    expect(isBlockedUrl("http://[::1]/")).toBe(true);
    expect(isBlockedUrl("http://::1/")).toBe(true);
  });

  test("blocks 0.0.0.0", () => {
    expect(isBlockedUrl("http://0.0.0.0/")).toBe(true);
    expect(isBlockedUrl("http://0.0.0.0:3000")).toBe(true);
  });

  test("blocks .internal and .local domains", () => {
    expect(isBlockedUrl("http://service.internal/api")).toBe(true);
    expect(isBlockedUrl("http://db.local:5432/")).toBe(true);
  });

  test("blocks IPv6 link-local (fe80::/10)", () => {
    expect(isBlockedUrl("http://[fe80::1]/")).toBe(true);
    expect(isBlockedUrl("http://[fe80::1%25eth0]:8080/")).toBe(true);
    expect(isBlockedUrl("http://[feb0::1]/")).toBe(true);
  });

  test("blocks IPv6 unique local addresses (fc00::/7)", () => {
    expect(isBlockedUrl("http://[fc00::1]/")).toBe(true);
    expect(isBlockedUrl("http://[fd12:3456::1]/")).toBe(true);
  });

  test("blocks IPv6 unspecified address (::)", () => {
    expect(isBlockedUrl("http://[::]/")).toBe(true);
    expect(isBlockedUrl("http://::/")).toBe(true);
  });

  test("blocks numeric IPv4 (decimal integer form)", () => {
    // 2130706433 = 127.0.0.1
    expect(isBlockedUrl("http://2130706433/")).toBe(true);
    // 167772161 = 10.0.0.1
    expect(isBlockedUrl("http://167772161/secret")).toBe(true);
  });

  test("blocks octal IPv4", () => {
    // 0177.0.0.1 = 127.0.0.1
    expect(isBlockedUrl("http://0177.0.0.1/")).toBe(true);
  });

  test("blocks hex IPv4", () => {
    // 0x7f.0.0.1 = 127.0.0.1
    expect(isBlockedUrl("http://0x7f.0.0.1/")).toBe(true);
    expect(isBlockedUrl("http://0x7f000001/")).toBe(true);
  });

  test("allows public URLs", () => {
    expect(isBlockedUrl("https://example.com")).toBe(false);
    expect(isBlockedUrl("https://api.github.com/repos")).toBe(false);
    expect(isBlockedUrl("http://8.8.8.8/")).toBe(false);
    expect(isBlockedUrl("https://www.google.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBlockedIp (resolved IP validation — second pass)
// ---------------------------------------------------------------------------

describe("isBlockedIp", () => {
  // IPv4 loopback (127.0.0.0/8)
  test("blocks IPv4 loopback addresses", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.0.0.0")).toBe(true);
    expect(isBlockedIp("127.255.255.255")).toBe(true);
    expect(isBlockedIp("127.1.2.3")).toBe(true);
  });

  // RFC 1918: 10.0.0.0/8
  test("blocks IPv4 10.x.x.x private range", () => {
    expect(isBlockedIp("10.0.0.0")).toBe(true);
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("10.255.255.255")).toBe(true);
    expect(isBlockedIp("10.128.64.32")).toBe(true);
  });

  // RFC 1918: 172.16.0.0/12
  test("blocks IPv4 172.16.0.0/12 private range", () => {
    expect(isBlockedIp("172.16.0.0")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("172.20.10.5")).toBe(true);
  });

  test("allows IPv4 addresses outside 172.16.0.0/12", () => {
    expect(isBlockedIp("172.15.255.255")).toBe(false);
    expect(isBlockedIp("172.32.0.0")).toBe(false);
  });

  // RFC 1918: 192.168.0.0/16
  test("blocks IPv4 192.168.x.x private range", () => {
    expect(isBlockedIp("192.168.0.0")).toBe(true);
    expect(isBlockedIp("192.168.0.1")).toBe(true);
    expect(isBlockedIp("192.168.255.255")).toBe(true);
    expect(isBlockedIp("192.168.1.100")).toBe(true);
  });

  // Link-local: 169.254.0.0/16
  test("blocks IPv4 link-local addresses (169.254.x.x)", () => {
    expect(isBlockedIp("169.254.0.0")).toBe(true);
    expect(isBlockedIp("169.254.0.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("169.254.255.255")).toBe(true);
  });

  // Unspecified: 0.0.0.0/8
  test("blocks IPv4 unspecified addresses (0.x.x.x)", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("0.0.0.1")).toBe(true);
    expect(isBlockedIp("0.255.255.255")).toBe(true);
  });

  // Public IPv4
  test("allows public IPv4 addresses", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("203.0.113.1")).toBe(false);
    expect(isBlockedIp("192.0.2.1")).toBe(false);
  });

  // IPv6 loopback
  test("blocks IPv6 loopback (::1)", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("0:0:0:0:0:0:0:1")).toBe(true);
  });

  // IPv6 unspecified
  test("blocks IPv6 unspecified address (::)", () => {
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("0:0:0:0:0:0:0:0")).toBe(true);
  });

  // IPv6 link-local (fe80::/10)
  test("blocks IPv6 link-local addresses (fe80::/10)", () => {
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fe80::abcd:1234")).toBe(true);
    expect(isBlockedIp("FE80::1")).toBe(true);
  });

  // IPv6 unique local (fc00::/7 = fc00::/8 + fd00::/8)
  test("blocks IPv6 unique local addresses (fc00::/7)", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
    expect(isBlockedIp("FC00::1")).toBe(true);
  });

  // IPv4-mapped IPv6
  test("blocks IPv4-mapped IPv6 with private IPv4", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:192.168.1.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
  });

  test("allows IPv4-mapped IPv6 with public IPv4", () => {
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIp("::ffff:93.184.216.34")).toBe(false);
  });

  // Public IPv6
  test("allows public IPv6 addresses", () => {
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  // Edge cases
  test("blocks unparseable IPv4 defensively", () => {
    expect(isBlockedIp("999.999.999.999")).toBe(true);
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});
