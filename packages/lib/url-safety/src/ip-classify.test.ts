import { describe, expect, test } from "bun:test";
import { isBlockedIp } from "./ip-classify.js";

describe("isBlockedIp — IPv4", () => {
  test.each([
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  test.each(["1.1.1.1", "8.8.8.8", "142.250.190.78", "93.184.216.34"])("allows public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  test("allows 172.15.x and 172.32.x (edges of RFC1918 172.16.0.0/12)", () => {
    expect(isBlockedIp("172.15.0.1")).toBe(false);
    expect(isBlockedIp("172.32.0.1")).toBe(false);
  });

  test("rejects malformed IPv4 as blocked (fail-closed)", () => {
    expect(isBlockedIp("999.999.999.999")).toBe(true);
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("isBlockedIp — IPv6", () => {
  test.each([
    "::1",
    "0:0:0:0:0:0:0:1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::abcd",
    "ff00::1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 of private v4", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 in hex
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });

  test("blocks fd00:ec2::254 (AWS IPv6 IMDS)", () => {
    expect(isBlockedIp("fd00:ec2::254")).toBe(true);
  });

  test("blocks 2001:db8 documentation range", () => {
    expect(isBlockedIp("2001:db8::1")).toBe(true);
  });

  test("blocks 6to4 (2002::/16) embedding private IPv4", () => {
    // 2002:7f00:0001:: → embeds 127.0.0.1 (loopback)
    expect(isBlockedIp("2002:7f00:0001::")).toBe(true);
    // 2002:a9fe:a9fe:: → embeds 169.254.169.254 (IMDS)
    expect(isBlockedIp("2002:a9fe:a9fe::")).toBe(true);
  });

  test("allows 6to4 (2002::/16) embedding public IPv4", () => {
    // 2002:0101:0101:: → embeds 1.1.1.1 (public)
    expect(isBlockedIp("2002:0101:0101::")).toBe(false);
  });

  test("blocks malformed IPv6-like strings (fail-closed)", () => {
    expect(isBlockedIp("gggg::1")).toBe(true);
    expect(isBlockedIp("::zzzz")).toBe(true);
    expect(isBlockedIp("not::valid")).toBe(true);
  });

  test("blocks IPv4-compatible IPv6 (::/96, deprecated RFC4291) of private v4", () => {
    // URL parser canonicalises `[::127.0.0.1]` to `[::7f00:1]` — must still block.
    expect(isBlockedIp("::7f00:1")).toBe(true);
    // `::a00:1` encodes 10.0.0.1 (RFC1918).
    expect(isBlockedIp("::a00:1")).toBe(true);
    // `::a9fe:a9fe` encodes 169.254.169.254 (AWS IMDS).
    expect(isBlockedIp("::a9fe:a9fe")).toBe(true);
    // dotted-decimal form parsed by Node.
    expect(isBlockedIp("::127.0.0.1")).toBe(true);
  });

  test("allows IPv4-compatible IPv6 of public v4", () => {
    // `::808:808` encodes 8.8.8.8 (public).
    expect(isBlockedIp("::808:808")).toBe(false);
    expect(isBlockedIp("::8.8.8.8")).toBe(false);
  });

  test("blocks ENTIRE NAT64 local-use prefix (64:ff9b:1::/48) — site-operator translator space", () => {
    // RFC6052-valid /48 encodings are blocked.
    expect(isBlockedIp("64:ff9b:1:7f00:0:100::")).toBe(true);
    expect(isBlockedIp("64:ff9b:1:808:8:800::")).toBe(true);
    expect(isBlockedIp("64:ff9b:1:a9fe:a9:fe00::")).toBe(true);
    // Non-RFC6052 encodings inside the /48 are ALSO blocked (previous bug:
    // these fell through because the v4 decoder rejected the non-zero u
    // octet or bad suffix).
    expect(isBlockedIp("64:ff9b:1:ffff:ffff:ffff::")).toBe(true);
    expect(isBlockedIp("64:ff9b:1::1")).toBe(true);
    expect(isBlockedIp("64:ff9b:1:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });

  test("blocks deprecated IPv6 site-local (fec0::/10)", () => {
    expect(isBlockedIp("fec0::1")).toBe(true);
    expect(isBlockedIp("feff::1234")).toBe(true);
  });

  test("blocks NAT64 (64:ff9b::/96) embedding private IPv4", () => {
    // 64:ff9b::c0a8:1 → embeds 192.168.0.1 (RFC1918)
    expect(isBlockedIp("64:ff9b::c0a8:1")).toBe(true);
    // 64:ff9b::7f00:1 → embeds 127.0.0.1 (loopback)
    expect(isBlockedIp("64:ff9b::7f00:1")).toBe(true);
    // dotted-decimal form — 64:ff9b::169.254.169.254 (IMDS)
    expect(isBlockedIp("64:ff9b::169.254.169.254")).toBe(true);
  });

  test("blocks 100::/64 discard-only (RFC6666)", () => {
    expect(isBlockedIp("100::1")).toBe(true);
    expect(isBlockedIp("100::ffff:abcd")).toBe(true);
  });

  test("blocks zero-padded variants of Teredo/doc/6to4", () => {
    // Zero-padded first hextet must still match — the expander normalizes.
    expect(isBlockedIp("2001:0000::1")).toBe(true);
    expect(isBlockedIp("2001:0db8::1")).toBe(true);
  });

  test("allows routable public IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });
});
