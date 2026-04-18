import { describe, expect, test } from "bun:test";
import { BLOCKED_CIDR_RANGES, BLOCKED_HOSTS, EMBEDDED_V4_IPV6_PREFIXES } from "./blocked.js";

describe("BLOCKED_HOSTS", () => {
  test("includes cloud metadata hostnames and loopback aliases", () => {
    expect(BLOCKED_HOSTS).toContain("metadata.google.internal");
    expect(BLOCKED_HOSTS).toContain("localhost");
    expect(BLOCKED_HOSTS).toContain("0.0.0.0");
  });

  test("is frozen — extending at runtime throws in strict mode", () => {
    expect(Object.isFrozen(BLOCKED_HOSTS)).toBe(true);
  });
});

describe("BLOCKED_CIDR_RANGES", () => {
  test("covers RFC1918 + loopback + link-local + CGNAT + IPv6 ULA", () => {
    expect(BLOCKED_CIDR_RANGES).toContain("10.0.0.0/8");
    expect(BLOCKED_CIDR_RANGES).toContain("172.16.0.0/12");
    expect(BLOCKED_CIDR_RANGES).toContain("192.168.0.0/16");
    expect(BLOCKED_CIDR_RANGES).toContain("127.0.0.0/8");
    expect(BLOCKED_CIDR_RANGES).toContain("169.254.0.0/16");
    expect(BLOCKED_CIDR_RANGES).toContain("100.64.0.0/10");
    expect(BLOCKED_CIDR_RANGES).toContain("::1/128");
    expect(BLOCKED_CIDR_RANGES).toContain("fc00::/7");
    expect(BLOCKED_CIDR_RANGES).toContain("fe80::/10");
  });

  test("64:ff9b:1::/48 is full-block (site-operator translator)", () => {
    // Unlike the /96 well-known which allows public embedded v4 through,
    // the /48 local-use prefix is operator-internal infrastructure and
    // blocked wholesale.
    expect(BLOCKED_CIDR_RANGES).toContain("64:ff9b:1::/48");
  });

  test("does NOT contain embedded-v4 IPv6 prefixes (those are a separate class)", () => {
    // These prefixes allow public embedded v4 through — they belong to
    // EMBEDDED_V4_IPV6_PREFIXES, not the full-block list.
    expect(BLOCKED_CIDR_RANGES).not.toContain("::ffff:0:0/96");
    expect(BLOCKED_CIDR_RANGES).not.toContain("64:ff9b::/96");
    expect(BLOCKED_CIDR_RANGES).not.toContain("2002::/16");
  });

  test("is frozen", () => {
    expect(Object.isFrozen(BLOCKED_CIDR_RANGES)).toBe(true);
  });
});

describe("EMBEDDED_V4_IPV6_PREFIXES", () => {
  test("lists every IPv6 prefix whose embedded v4 the classifier re-checks", () => {
    expect(EMBEDDED_V4_IPV6_PREFIXES).toContain("::ffff:0:0/96");
    expect(EMBEDDED_V4_IPV6_PREFIXES).toContain("::/96");
    expect(EMBEDDED_V4_IPV6_PREFIXES).toContain("64:ff9b::/96");
    expect(EMBEDDED_V4_IPV6_PREFIXES).toContain("2002::/16");
  });

  test("does NOT contain 64:ff9b:1::/48 (promoted to full-block)", () => {
    expect(EMBEDDED_V4_IPV6_PREFIXES).not.toContain("64:ff9b:1::/48");
  });

  test("is frozen", () => {
    expect(Object.isFrozen(EMBEDDED_V4_IPV6_PREFIXES)).toBe(true);
  });
});
