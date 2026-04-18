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
