import { describe, expect, test } from "bun:test";
import { isBlockedUrl } from "./url-policy.js";

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
