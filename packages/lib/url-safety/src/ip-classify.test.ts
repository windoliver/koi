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

  test("allows routable public IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });
});
