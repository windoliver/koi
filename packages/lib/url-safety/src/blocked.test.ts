import { describe, expect, test } from "bun:test";
import { BLOCKED_CIDR_RANGES, BLOCKED_HOSTS } from "./blocked.js";

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

  test("is frozen", () => {
    expect(Object.isFrozen(BLOCKED_CIDR_RANGES)).toBe(true);
  });
});
