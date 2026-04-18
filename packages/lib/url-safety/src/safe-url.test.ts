import { describe, expect, test } from "bun:test";
import { isSafeUrl } from "./safe-url.js";

const mapResolver = (map: Readonly<Record<string, readonly string[]>>) => {
  return async (hostname: string): Promise<readonly string[]> => {
    const addrs = map[hostname];
    if (addrs === undefined) throw new Error(`ENOTFOUND ${hostname}`);
    return addrs;
  };
};

describe("isSafeUrl", () => {
  test("allows public hostname that resolves to public IP", async () => {
    const result = await isSafeUrl("https://example.com/x", {
      dnsResolver: mapResolver({ "example.com": ["93.184.216.34"] }),
    });
    expect(result.ok).toBe(true);
  });

  test("blocks IP literal that is private", async () => {
    const result = await isSafeUrl("http://127.0.0.1/path");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("127.0.0.1");
  });

  test("blocks cloud metadata IP literal", async () => {
    const result = await isSafeUrl("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
  });

  test("canonicalises trailing-dot FQDN in blocklist/suffix/allowlist checks", async () => {
    // DNS allows a single trailing root dot. Without canonicalisation,
    // `service.internal.` would sidestep the .internal suffix match, and
    // `localhost.` would miss the BLOCKED_HOSTS exact match.
    const r1 = await isSafeUrl("http://service.internal./x");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/\.internal/);

    const r2 = await isSafeUrl("http://printer.local./admin");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/\.local/);

    const r3 = await isSafeUrl("http://localhost./", {
      dnsResolver: async () => ["93.184.216.34"],
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toMatch(/localhost/);

    const r4 = await isSafeUrl("http://metadata.google.internal./x");
    expect(r4.ok).toBe(false);
  });

  test("blocks BLOCKED_HOSTS entry", async () => {
    const result = await isSafeUrl("http://metadata.google.internal/computeMetadata/v1/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("metadata.google.internal");
  });

  test("blocks DNS-rebound hostname (public name → private IP)", async () => {
    const result = await isSafeUrl("https://evil.example.com/x", {
      dnsResolver: mapResolver({ "evil.example.com": ["127.0.0.1"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("127.0.0.1");
  });

  test("blocks if ANY resolved IP is private (multi-homed)", async () => {
    const result = await isSafeUrl("https://mixed.example.com/", {
      dnsResolver: mapResolver({
        "mixed.example.com": ["93.184.216.34", "10.0.0.5"],
      }),
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-http(s) protocols", async () => {
    const result = await isSafeUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/protocol/i);
  });

  test("rejects malformed URL", async () => {
    const result = await isSafeUrl("not a url");
    expect(result.ok).toBe(false);
  });

  test("fails closed on DNS resolver error", async () => {
    const result = await isSafeUrl("https://example.com/", {
      dnsResolver: async () => {
        throw new Error("boom");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/DNS/i);
  });

  test("fails closed when resolver returns zero addresses", async () => {
    const result = await isSafeUrl("https://example.com/", {
      dnsResolver: async () => [],
    });
    expect(result.ok).toBe(false);
  });

  test("allowPrivate=true skips blocklist but still enforces protocol", async () => {
    const ok = await isSafeUrl("http://127.0.0.1/", { allowPrivate: true });
    expect(ok.ok).toBe(true);

    const bad = await isSafeUrl("file:///x", { allowPrivate: true });
    expect(bad.ok).toBe(false);
  });

  test("allowPrivate=true still resolves DNS so pinning can use validated IPs", async () => {
    const result = await isSafeUrl("https://example.com/", {
      allowPrivate: true,
      dnsResolver: mapResolver({ "example.com": ["127.0.0.1"] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedIps).toEqual(["127.0.0.1"]);
  });

  test("default resolver must fail when A succeeds but AAAA errors (full-coverage invariant)", async () => {
    // Simulate the built-in authoritative-strict default by injecting a
    // resolver that throws — isSafeUrl must propagate that as a rejection.
    // createSafeFetcher cannot pin HTTPS to an IP, so the validator must
    // observe the complete A+AAAA set before approving. A partial answer
    // (public A seen, blocked AAAA hidden behind a transient error) would
    // otherwise slip past the check.
    const result = await isSafeUrl("https://mixed.example.com/", {
      dnsResolver: async () => {
        throw Object.assign(new Error("SERVFAIL on AAAA"), { code: "SERVFAIL" });
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/DNS|SERVFAIL/i);
  });

  test("allowPrivate=true keeps DNS failure fatal (rebind-safety invariant)", async () => {
    const result = await isSafeUrl("https://unknown.example.com/", {
      allowPrivate: true,
      dnsResolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/DNS/i);
  });

  test("allowlistHosts does NOT grant access to private IPs via resolution", async () => {
    // Trusting a hostname shouldn't grant reachability to 127.0.0.1
    // just because the hostname happens to resolve there. The allowlist
    // applies to the HOST, not the address it happens to resolve to.
    // Callers that really need this must set allowPrivate: true.
    const result = await isSafeUrl("http://trusted.example.com/", {
      allowlistHosts: ["trusted.example.com"],
      dnsResolver: mapResolver({ "trusted.example.com": ["127.0.0.1"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/127\.0\.0\.1/);
  });

  test("allowlistHosts allows a hostname that resolves to a PUBLIC IP", async () => {
    const result = await isSafeUrl("http://trusted.example.com/", {
      allowlistHosts: ["trusted.example.com"],
      dnsResolver: mapResolver({ "trusted.example.com": ["93.184.216.34"] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedIps).toEqual(["93.184.216.34"]);
  });

  test("allowPrivate=true DOES grant access to a private-resolving allowlisted hostname", async () => {
    // When the caller explicitly opts out of private-IP gating, the
    // hostname-resolves-to-127.0.0.1 path is allowed.
    const result = await isSafeUrl("http://trusted.example.com/", {
      allowlistHosts: ["trusted.example.com"],
      allowPrivate: true,
      dnsResolver: mapResolver({ "trusted.example.com": ["127.0.0.1"] }),
    });
    expect(result.ok).toBe(true);
  });

  test("allowlistHosts keeps DNS failure fatal even for allowlisted hostnames", async () => {
    const result = await isSafeUrl("http://trusted.example.com/", {
      allowlistHosts: ["trusted.example.com"],
      dnsResolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.ok).toBe(false);
  });

  test("allowlistHosts bypasses blocklist for explicit host only", async () => {
    const result = await isSafeUrl("http://127.0.0.1/", {
      allowlistHosts: ["127.0.0.1"],
    });
    expect(result.ok).toBe(true);

    const other = await isSafeUrl("http://10.0.0.5/", {
      allowlistHosts: ["127.0.0.1"],
    });
    expect(other.ok).toBe(false);
  });
});
