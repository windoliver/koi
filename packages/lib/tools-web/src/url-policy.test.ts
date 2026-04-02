import { describe, expect, test } from "bun:test";
import { isBlockedIp, isBlockedUrl, pinResolvedIp } from "./url-policy.js";

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

  test("blocks RFC 6598 shared address space (100.64.0.0/10)", () => {
    expect(isBlockedUrl("http://100.64.0.1/")).toBe(true);
    expect(isBlockedUrl("http://100.127.255.255/")).toBe(true);
  });

  test("blocks RFC 5737 documentation ranges", () => {
    expect(isBlockedUrl("http://192.0.2.1/")).toBe(true);
    expect(isBlockedUrl("http://198.51.100.1/")).toBe(true);
    expect(isBlockedUrl("http://203.0.113.1/")).toBe(true);
  });

  test("blocks RFC 6890 benchmarking range (198.18-19.x.x)", () => {
    expect(isBlockedUrl("http://198.18.0.1/")).toBe(true);
    expect(isBlockedUrl("http://198.19.255.255/")).toBe(true);
  });

  test("blocks broadcast address", () => {
    expect(isBlockedUrl("http://255.255.255.255/")).toBe(true);
  });

  test("blocks AWS/cloud metadata endpoint", () => {
    expect(isBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(isBlockedUrl("http://169.254.0.1/")).toBe(true);
  });

  test("blocks IPv6 loopback", () => {
    expect(isBlockedUrl("http://[::1]/")).toBe(true);
    expect(isBlockedUrl("http://::1/")).toBe(true);
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

  test("blocks 0.0.0.0", () => {
    expect(isBlockedUrl("http://0.0.0.0/")).toBe(true);
    expect(isBlockedUrl("http://0.0.0.0:3000")).toBe(true);
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

  test("blocks .internal and .local domains", () => {
    expect(isBlockedUrl("http://service.internal/api")).toBe(true);
    expect(isBlockedUrl("http://db.local:5432/")).toBe(true);
  });

  test("allows public URLs", () => {
    expect(isBlockedUrl("https://example.com")).toBe(false);
    expect(isBlockedUrl("https://api.github.com/repos")).toBe(false);
    expect(isBlockedUrl("http://8.8.8.8/")).toBe(false);
    expect(isBlockedUrl("https://www.google.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBlockedIp (resolved IP validation -- second pass)
// ---------------------------------------------------------------------------

describe("isBlockedIp", () => {
  test("blocks IPv4 loopback addresses", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.0.0.0")).toBe(true);
    expect(isBlockedIp("127.255.255.255")).toBe(true);
    expect(isBlockedIp("127.1.2.3")).toBe(true);
  });

  test("blocks IPv4 10.x.x.x private range", () => {
    expect(isBlockedIp("10.0.0.0")).toBe(true);
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("10.255.255.255")).toBe(true);
    expect(isBlockedIp("10.128.64.32")).toBe(true);
  });

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

  test("blocks IPv4 192.168.x.x private range", () => {
    expect(isBlockedIp("192.168.0.0")).toBe(true);
    expect(isBlockedIp("192.168.0.1")).toBe(true);
    expect(isBlockedIp("192.168.255.255")).toBe(true);
    expect(isBlockedIp("192.168.1.100")).toBe(true);
  });

  test("blocks RFC 6598 shared address space (100.64.0.0/10)", () => {
    expect(isBlockedIp("100.64.0.0")).toBe(true);
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("100.127.255.255")).toBe(true);
  });

  test("blocks RFC 5737 documentation ranges", () => {
    expect(isBlockedIp("192.0.2.0")).toBe(true);
    expect(isBlockedIp("192.0.2.1")).toBe(true);
    expect(isBlockedIp("198.51.100.0")).toBe(true);
    expect(isBlockedIp("198.51.100.1")).toBe(true);
    expect(isBlockedIp("203.0.113.0")).toBe(true);
    expect(isBlockedIp("203.0.113.1")).toBe(true);
  });

  test("blocks RFC 6890 benchmarking range (198.18.0.0/15)", () => {
    expect(isBlockedIp("198.18.0.0")).toBe(true);
    expect(isBlockedIp("198.18.0.1")).toBe(true);
    expect(isBlockedIp("198.19.255.255")).toBe(true);
  });

  test("blocks broadcast address", () => {
    expect(isBlockedIp("255.255.255.255")).toBe(true);
  });

  test("blocks IPv4 link-local addresses (169.254.x.x)", () => {
    expect(isBlockedIp("169.254.0.0")).toBe(true);
    expect(isBlockedIp("169.254.0.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("169.254.255.255")).toBe(true);
  });

  test("blocks IPv4 unspecified addresses (0.x.x.x)", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("0.0.0.1")).toBe(true);
    expect(isBlockedIp("0.255.255.255")).toBe(true);
  });

  test("allows public IPv4 addresses", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("93.184.216.34")).toBe(false);
  });

  test("blocks IPv6 loopback (::1)", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("0:0:0:0:0:0:0:1")).toBe(true);
  });

  test("blocks IPv6 unspecified address (::)", () => {
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("0:0:0:0:0:0:0:0")).toBe(true);
  });

  test("blocks IPv6 link-local addresses (fe80::/10)", () => {
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fe80::abcd:1234")).toBe(true);
    expect(isBlockedIp("FE80::1")).toBe(true);
    expect(isBlockedIp("fe90::1")).toBe(true);
    expect(isBlockedIp("fea0::1")).toBe(true);
    expect(isBlockedIp("feb0::1")).toBe(true);
    expect(isBlockedIp("febf::1")).toBe(true);
    // fec0:: is NOT link-local (outside /10)
    expect(isBlockedIp("fec0::1")).toBe(false);
  });

  test("blocks IPv6 unique local addresses (fc00::/7)", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
    expect(isBlockedIp("FC00::1")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 (dotted) with private IPv4", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:192.168.1.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
  });

  test("allows IPv4-mapped IPv6 (dotted) with public IPv4", () => {
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIp("::ffff:93.184.216.34")).toBe(false);
  });

  test("blocks IPv4-mapped IPv6 (hex) with private IPv4", () => {
    // ::ffff:7f00:1 = 127.0.0.1
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
    // ::ffff:a00:1 = 10.0.0.1
    expect(isBlockedIp("::ffff:a00:1")).toBe(true);
    // ::ffff:c0a8:101 = 192.168.1.1
    expect(isBlockedIp("::ffff:c0a8:101")).toBe(true);
    // ::ffff:a9fe:a9fe = 169.254.169.254
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true);
  });

  test("allows IPv4-mapped IPv6 (hex) with public IPv4", () => {
    // ::ffff:808:808 = 8.8.8.8
    expect(isBlockedIp("::ffff:808:808")).toBe(false);
    // ::ffff:5db8:d822 = 93.184.216.34
    expect(isBlockedIp("::ffff:5db8:d822")).toBe(false);
  });

  test("allows public IPv6 addresses", () => {
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  test("blocks unparseable IPv4 defensively", () => {
    expect(isBlockedIp("999.999.999.999")).toBe(true);
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pinResolvedIp (IP pinning for DNS rebinding prevention)
// ---------------------------------------------------------------------------

describe("pinResolvedIp", () => {
  test("pins IPv4 for HTTP URL", () => {
    const result = pinResolvedIp("http://example.com/path?q=1", "93.184.216.34");
    expect(result).not.toBeUndefined();
    expect(result?.url).toBe("http://93.184.216.34/path?q=1");
    expect(result?.hostHeader).toBe("example.com");
  });

  test("pins IPv4 for HTTP URL with non-default port", () => {
    const result = pinResolvedIp("http://example.com:8080/api", "93.184.216.34");
    expect(result).not.toBeUndefined();
    expect(result?.url).toBe("http://93.184.216.34:8080/api");
    expect(result?.hostHeader).toBe("example.com:8080");
  });

  test("pins IPv6 for HTTP URL (wraps in brackets)", () => {
    const result = pinResolvedIp("http://example.com/", "2001:db8::1");
    expect(result).not.toBeUndefined();
    expect(result?.url).toBe("http://[2001:db8::1]/");
    expect(result?.hostHeader).toBe("example.com");
  });

  test("returns undefined for HTTPS (no SNI support)", () => {
    const result = pinResolvedIp("https://example.com/", "93.184.216.34");
    expect(result).toBeUndefined();
  });

  test("returns undefined for invalid URL", () => {
    const result = pinResolvedIp("not-a-url", "1.2.3.4");
    expect(result).toBeUndefined();
  });
});
