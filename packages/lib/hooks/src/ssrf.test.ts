import { describe, expect, it } from "bun:test";
import type { DnsResolverFn } from "./ssrf.js";
import { isBlockedHookIp, pinResolvedIp, resolveAndValidateHookUrl } from "./ssrf.js";

// ---------------------------------------------------------------------------
// isBlockedHookIp
// ---------------------------------------------------------------------------

describe("isBlockedHookIp", () => {
  describe("blocks private/reserved IPv4", () => {
    const blocked = [
      ["0.0.0.0", "0.0.0.0/8"],
      ["0.1.2.3", "0.0.0.0/8"],
      ["10.0.0.1", "10.0.0.0/8"],
      ["10.255.255.255", "10.0.0.0/8"],
      ["100.64.0.1", "100.64.0.0/10 (CGNAT)"],
      ["100.127.255.255", "100.64.0.0/10 (CGNAT)"],
      ["169.254.0.1", "169.254.0.0/16 (link-local)"],
      ["169.254.169.254", "cloud metadata"],
      ["172.16.0.1", "172.16.0.0/12"],
      ["172.31.255.255", "172.16.0.0/12"],
      ["192.168.0.1", "192.168.0.0/16"],
      ["192.168.255.255", "192.168.0.0/16"],
      ["192.0.2.1", "TEST-NET-1"],
      ["198.51.100.1", "TEST-NET-2"],
      ["203.0.113.1", "TEST-NET-3"],
      ["198.18.0.1", "benchmarking"],
      ["198.19.255.255", "benchmarking"],
      ["255.255.255.255", "broadcast"],
    ] as const;

    for (const [ip, label] of blocked) {
      it(`blocks ${ip} (${label})`, () => {
        expect(isBlockedHookIp(ip)).toBe(true);
      });
    }
  });

  describe("allows narrow loopback", () => {
    it("allows 127.0.0.1", () => {
      expect(isBlockedHookIp("127.0.0.1")).toBe(false);
    });

    it("blocks 127.0.0.2", () => {
      expect(isBlockedHookIp("127.0.0.2")).toBe(true);
    });

    it("blocks 127.1.0.0", () => {
      expect(isBlockedHookIp("127.1.0.0")).toBe(true);
    });
  });

  describe("allows public IPv4", () => {
    const allowed = ["8.8.8.8", "93.184.216.34", "1.1.1.1", "104.18.27.120"] as const;
    for (const ip of allowed) {
      it(`allows ${ip}`, () => {
        expect(isBlockedHookIp(ip)).toBe(false);
      });
    }
  });

  describe("blocks private/reserved IPv6", () => {
    it("blocks :: (unspecified)", () => {
      expect(isBlockedHookIp("::")).toBe(true);
    });

    it("blocks expanded unspecified", () => {
      expect(isBlockedHookIp("0:0:0:0:0:0:0:0")).toBe(true);
    });

    it("blocks fe80:: (link-local)", () => {
      expect(isBlockedHookIp("fe80::1")).toBe(true);
    });

    it("blocks fc00:: (unique local)", () => {
      expect(isBlockedHookIp("fc00::1")).toBe(true);
    });

    it("blocks fd00:: (unique local)", () => {
      expect(isBlockedHookIp("fd12::1")).toBe(true);
    });
  });

  describe("allows narrow IPv6 loopback", () => {
    it("allows ::1", () => {
      expect(isBlockedHookIp("::1")).toBe(false);
    });

    it("allows expanded ::1", () => {
      expect(isBlockedHookIp("0:0:0:0:0:0:0:1")).toBe(false);
    });
  });

  describe("allows public IPv6", () => {
    it("allows 2001:4860:4860::8888", () => {
      expect(isBlockedHookIp("2001:4860:4860::8888")).toBe(false);
    });

    it("allows 2606:4700::6812:1b78", () => {
      expect(isBlockedHookIp("2606:4700::6812:1b78")).toBe(false);
    });
  });

  describe("handles IPv4-mapped IPv6", () => {
    it("blocks ::ffff:169.254.169.254 (dotted)", () => {
      expect(isBlockedHookIp("::ffff:169.254.169.254")).toBe(true);
    });

    it("blocks ::ffff:a9fe:a9fe (hex form)", () => {
      expect(isBlockedHookIp("::ffff:a9fe:a9fe")).toBe(true);
    });

    it("blocks ::ffff:10.0.0.1 (dotted)", () => {
      expect(isBlockedHookIp("::ffff:10.0.0.1")).toBe(true);
    });

    it("allows ::ffff:8.8.8.8 (public mapped)", () => {
      expect(isBlockedHookIp("::ffff:8.8.8.8")).toBe(false);
    });

    it("allows ::ffff:127.0.0.1 (loopback mapped)", () => {
      expect(isBlockedHookIp("::ffff:127.0.0.1")).toBe(false);
    });

    it("blocks ::ffff:127.0.0.2 (non-narrow loopback mapped)", () => {
      expect(isBlockedHookIp("::ffff:127.0.0.2")).toBe(true);
    });
  });

  describe("handles IPv4-compatible IPv6 (deprecated)", () => {
    it("blocks ::10.0.0.1 (private via compat)", () => {
      expect(isBlockedHookIp("::10.0.0.1")).toBe(true);
    });

    it("blocks ::169.254.169.254 (metadata via compat)", () => {
      expect(isBlockedHookIp("::169.254.169.254")).toBe(true);
    });

    it("allows ::8.8.8.8 (public via compat)", () => {
      expect(isBlockedHookIp("::8.8.8.8")).toBe(false);
    });
  });

  describe("handles IPv6 zone IDs", () => {
    it("blocks fe80::1%eth0 (link-local with zone)", () => {
      expect(isBlockedHookIp("fe80::1%eth0")).toBe(true);
    });

    it("blocks ::ffff:169.254.169.254%eth0 (mapped with zone)", () => {
      expect(isBlockedHookIp("::ffff:169.254.169.254%eth0")).toBe(true);
    });

    it("allows ::1%lo0 (loopback with zone)", () => {
      expect(isBlockedHookIp("::1%lo0")).toBe(false);
    });
  });

  describe("handles fully-expanded IPv4-mapped IPv6", () => {
    it("blocks 0:0:0:0:0:ffff:a9fe:a9fe (expanded metadata)", () => {
      expect(isBlockedHookIp("0:0:0:0:0:ffff:a9fe:a9fe")).toBe(true);
    });

    it("blocks 0:0:0:0:0:ffff:0a00:0001 (expanded 10.0.0.1)", () => {
      expect(isBlockedHookIp("0:0:0:0:0:ffff:0a00:0001")).toBe(true);
    });

    it("blocks 0000:0000:0000:0000:0000:ffff:0a00:0001 (leading zeros)", () => {
      expect(isBlockedHookIp("0000:0000:0000:0000:0000:ffff:0a00:0001")).toBe(true);
    });
  });

  describe("handles IPv4-compatible hex form (deprecated)", () => {
    it("blocks ::a9fe:a9fe (metadata in hex compat)", () => {
      expect(isBlockedHookIp("::a9fe:a9fe")).toBe(true);
    });

    it("blocks ::0a00:0001 (10.0.0.1 in hex compat)", () => {
      expect(isBlockedHookIp("::0a00:0001")).toBe(true);
    });

    it("blocks ::c0a8:0001 (192.168.0.1 in hex compat)", () => {
      expect(isBlockedHookIp("::c0a8:0001")).toBe(true);
    });

    it("allows ::0808:0808 (8.8.8.8 in hex compat)", () => {
      expect(isBlockedHookIp("::0808:0808")).toBe(false);
    });
  });

  describe("blocks 6to4 (2002::/16) with embedded private IPv4", () => {
    it("blocks 2002:0a00:0001::1 (embeds 10.0.0.1)", () => {
      expect(isBlockedHookIp("2002:0a00:0001::1")).toBe(true);
    });

    it("blocks 2002:a9fe:a9fe::1 (embeds 169.254.169.254)", () => {
      expect(isBlockedHookIp("2002:a9fe:a9fe::1")).toBe(true);
    });

    it("allows 2002:0808:0808::1 (embeds 8.8.8.8)", () => {
      expect(isBlockedHookIp("2002:0808:0808::1")).toBe(false);
    });
  });

  describe("blocks NAT64 prefix", () => {
    it("blocks 64:ff9b::169.254.169.254", () => {
      expect(isBlockedHookIp("64:ff9b::169.254.169.254")).toBe(true);
    });

    it("blocks 64:ff9b::10.0.0.1", () => {
      expect(isBlockedHookIp("64:ff9b::10.0.0.1")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("blocks unparseable IPv4", () => {
      expect(isBlockedHookIp("999.999.999.999")).toBe(true);
    });

    it("blocks non-IP string", () => {
      expect(isBlockedHookIp("not-an-ip")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAndValidateHookUrl
// ---------------------------------------------------------------------------

describe("resolveAndValidateHookUrl", () => {
  const mockResolver = (ips: readonly string[]): DnsResolverFn => {
    return async (_hostname: string) => ips;
  };

  it("allows URL resolving to public IP", async () => {
    const result = await resolveAndValidateHookUrl(
      "https://example.com/hook",
      mockResolver(["93.184.216.34"]),
    );
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.ip).toBe("93.184.216.34");
      expect(result.hostname).toBe("example.com");
    }
  });

  it("blocks URL resolving to private IP", async () => {
    const result = await resolveAndValidateHookUrl(
      "https://evil.com/hook",
      mockResolver(["169.254.169.254"]),
    );
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("169.254.169.254");
      expect(result.reason).toContain("private/reserved");
    }
  });

  it("blocks when any resolved IP is private", async () => {
    const result = await resolveAndValidateHookUrl(
      "https://mixed.com/hook",
      mockResolver(["93.184.216.34", "10.0.0.1"]),
    );
    expect(result.blocked).toBe(true);
  });

  it("blocks on empty DNS result", async () => {
    const result = await resolveAndValidateHookUrl("https://empty.com/hook", mockResolver([]));
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("no addresses");
    }
  });

  it("blocks on DNS resolution error", async () => {
    const failResolver: DnsResolverFn = async () => {
      throw new Error("NXDOMAIN");
    };
    const result = await resolveAndValidateHookUrl("https://nxdomain.com/hook", failResolver);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("NXDOMAIN");
    }
  });

  it("validates IP literal directly without DNS", async () => {
    let called = false;
    const trackingResolver: DnsResolverFn = async () => {
      called = true;
      return [];
    };
    const result = await resolveAndValidateHookUrl("https://93.184.216.34/hook", trackingResolver);
    expect(result.blocked).toBe(false);
    expect(called).toBe(false);
  });

  it("blocks private IP literal", async () => {
    const result = await resolveAndValidateHookUrl("https://10.0.0.1/hook", mockResolver([]));
    expect(result.blocked).toBe(true);
  });

  it("allows loopback IP literal (127.0.0.1)", async () => {
    const result = await resolveAndValidateHookUrl("http://127.0.0.1:3000/hook", mockResolver([]));
    expect(result.blocked).toBe(false);
  });

  it("blocks invalid URL", async () => {
    const result = await resolveAndValidateHookUrl("not-a-url", mockResolver([]));
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("Invalid URL");
    }
  });
});

// ---------------------------------------------------------------------------
// pinResolvedIp
// ---------------------------------------------------------------------------

describe("pinResolvedIp", () => {
  it("pins IPv4 for HTTP URL", () => {
    const result = pinResolvedIp("http://example.com:8080/path?q=1", "93.184.216.34");
    expect(result).not.toBeUndefined();
    expect(result?.url).toBe("http://93.184.216.34:8080/path?q=1");
    expect(result?.hostHeader).toBe("example.com:8080");
  });

  it("pins IPv4 for HTTP URL without port", () => {
    const result = pinResolvedIp("http://example.com/hook", "93.184.216.34");
    expect(result).not.toBeUndefined();
    expect(result?.url).toBe("http://93.184.216.34/hook");
    expect(result?.hostHeader).toBe("example.com");
  });

  it("returns undefined for HTTPS (no pinning)", () => {
    const result = pinResolvedIp("https://example.com/hook", "93.184.216.34");
    expect(result).toBeUndefined();
  });

  it("wraps IPv6 in brackets", () => {
    const result = pinResolvedIp("http://example.com/hook", "2001:db8::1");
    expect(result).not.toBeUndefined();
    expect(result?.url).toContain("[2001:db8::1]");
  });

  it("returns undefined for invalid URL", () => {
    const result = pinResolvedIp("not-a-url", "1.2.3.4");
    expect(result).toBeUndefined();
  });
});
