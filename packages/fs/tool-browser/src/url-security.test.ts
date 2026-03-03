import { describe, expect, test } from "bun:test";
import {
  compileNavigationSecurity,
  parseSecureOptionalUrl,
  parseSecureUrl,
} from "./url-security.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blocked(url: string, config = compileNavigationSecurity()): boolean {
  const r = parseSecureUrl({ url }, "url", config);
  return !r.ok;
}

function allowed(url: string, config = compileNavigationSecurity()): boolean {
  return !blocked(url, config);
}

function errorFor(url: string, config = compileNavigationSecurity()): string {
  const r = parseSecureUrl({ url }, "url", config);
  if (r.ok) return "";
  return r.err.error;
}

function codeFor(url: string, config = compileNavigationSecurity()): string {
  const r = parseSecureUrl({ url }, "url", config);
  if (r.ok) return "";
  return r.err.code;
}

// ---------------------------------------------------------------------------
// compileNavigationSecurity defaults
// ---------------------------------------------------------------------------

describe("compileNavigationSecurity", () => {
  test("defaults to https and http protocols", () => {
    const cfg = compileNavigationSecurity();
    expect(cfg.allowedProtocols.has("https:")).toBe(true);
    expect(cfg.allowedProtocols.has("http:")).toBe(true);
    expect(cfg.allowedProtocols.has("file:")).toBe(false);
  });

  test("defaults to blockPrivateAddresses true", () => {
    const cfg = compileNavigationSecurity();
    expect(cfg.blockPrivateAddresses).toBe(true);
  });

  test("no domain restriction by default", () => {
    const cfg = compileNavigationSecurity();
    expect(cfg.exactDomains).toBeUndefined();
    expect(cfg.wildcardPatterns).toHaveLength(0);
  });

  test("compiles custom protocols", () => {
    const cfg = compileNavigationSecurity({ allowedProtocols: ["https:"] });
    expect(cfg.allowedProtocols.has("https:")).toBe(true);
    expect(cfg.allowedProtocols.has("http:")).toBe(false);
  });

  test("compiles exact domains", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["example.com", "api.example.com"] });
    expect(cfg.exactDomains?.has("example.com")).toBe(true);
    expect(cfg.exactDomains?.has("api.example.com")).toBe(true);
    expect(cfg.wildcardPatterns).toHaveLength(0);
  });

  test("compiles wildcard patterns", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["*.example.com"] });
    expect(cfg.exactDomains?.size).toBe(0);
    expect(cfg.wildcardPatterns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Protocol allowlist
// ---------------------------------------------------------------------------

describe("protocol allowlist", () => {
  test("allows https://", () => expect(allowed("https://example.com")).toBe(true));
  test("allows http://", () => expect(allowed("http://example.com")).toBe(true));
  test("blocks file://", () => expect(blocked("file:///etc/passwd")).toBe(true));
  test("blocks javascript:", () => expect(blocked("javascript:alert(1)")).toBe(true));
  test("blocks data:", () =>
    expect(blocked("data:text/html,<script>alert(1)</script>")).toBe(true));
  test("blocks ftp://", () => expect(blocked("ftp://example.com/file")).toBe(true));

  test("custom https-only config blocks http", () => {
    const cfg = compileNavigationSecurity({ allowedProtocols: ["https:"] });
    expect(blocked("http://example.com", cfg)).toBe(true);
    expect(allowed("https://example.com", cfg)).toBe(true);
  });

  test("blocked protocol returns PERMISSION code", () => {
    expect(codeFor("file:///etc/passwd")).toBe("PERMISSION");
  });

  test("blocked protocol message contains the disallowed protocol", () => {
    const msg = errorFor("file:///etc/passwd");
    expect(msg).toContain("file:");
    expect(msg).toContain("https:");
  });
});

// ---------------------------------------------------------------------------
// Private IPv4 blocking
// ---------------------------------------------------------------------------

describe("private IPv4 blocking", () => {
  // Loopback
  test("blocks 127.0.0.1", () => expect(blocked("https://127.0.0.1/")).toBe(true));
  test("blocks 127.0.0.2 (loopback range)", () => expect(blocked("https://127.0.0.2/")).toBe(true));
  test("blocks 127.255.255.255", () => expect(blocked("https://127.255.255.255/")).toBe(true));
  test("blocks localhost", () => expect(blocked("https://localhost/")).toBe(true));
  test("blocks 0.0.0.0", () => expect(blocked("https://0.0.0.0/")).toBe(true));

  // RFC 1918 — Class A (10.0.0.0/8)
  test("blocks 10.0.0.1", () => expect(blocked("https://10.0.0.1/")).toBe(true));
  test("blocks 10.255.255.255", () => expect(blocked("https://10.255.255.255/")).toBe(true));

  // RFC 1918 — Class B (172.16.0.0/12)
  test("blocks 172.16.0.1", () => expect(blocked("https://172.16.0.1/")).toBe(true));
  test("blocks 172.31.255.255", () => expect(blocked("https://172.31.255.255/")).toBe(true));
  test("allows 172.32.0.1 (outside RFC 1918)", () =>
    expect(allowed("https://172.32.0.1/")).toBe(true));
  test("allows 172.15.0.1 (outside RFC 1918)", () =>
    expect(allowed("https://172.15.0.1/")).toBe(true));

  // RFC 1918 — Class C (192.168.0.0/16)
  test("blocks 192.168.0.1", () => expect(blocked("https://192.168.0.1/")).toBe(true));
  test("blocks 192.168.255.255", () => expect(blocked("https://192.168.255.255/")).toBe(true));
  test("allows 192.169.1.1 (outside RFC 1918)", () =>
    expect(allowed("https://192.169.1.1/")).toBe(true));

  // Link-local (APIPA)
  test("blocks 169.254.0.1 (link-local)", () => expect(blocked("https://169.254.0.1/")).toBe(true));
  test("blocks 169.254.255.255", () => expect(blocked("https://169.254.255.255/")).toBe(true));

  // Public IPs — must be allowed
  test("allows 8.8.8.8 (public)", () => expect(allowed("https://8.8.8.8/")).toBe(true));
  test("allows 1.1.1.1 (public)", () => expect(allowed("https://1.1.1.1/")).toBe(true));
  test("allows 93.184.216.34 (example.com)", () =>
    expect(allowed("https://93.184.216.34/")).toBe(true));
});

// ---------------------------------------------------------------------------
// Cloud metadata blocking
// ---------------------------------------------------------------------------

describe("cloud metadata endpoint blocking", () => {
  test("blocks 169.254.169.254 (AWS/GCP/Azure)", () =>
    expect(blocked("https://169.254.169.254/latest/meta-data/")).toBe(true));
  test("blocks 169.254.169.123 (AWS time sync)", () =>
    expect(blocked("http://169.254.169.123/")).toBe(true));
  test("blocks metadata.google.internal", () =>
    expect(blocked("http://metadata.google.internal/computeMetadata/v1/")).toBe(true));
  test("blocks 100.100.100.200 (Alibaba Cloud)", () =>
    expect(blocked("http://100.100.100.200/")).toBe(true));
});

// ---------------------------------------------------------------------------
// Encoded IP bypass detection
// ---------------------------------------------------------------------------

describe("encoded IP bypass detection", () => {
  // Decimal encoding
  test("blocks decimal loopback: 2130706433 = 127.0.0.1", () =>
    expect(blocked("https://2130706433/")).toBe(true));
  test("blocks decimal private: 167772161 = 10.0.0.1", () =>
    expect(blocked("https://167772161/")).toBe(true));
  test("blocks decimal metadata: 2852039166 = 169.254.169.254", () =>
    expect(blocked("https://2852039166/")).toBe(true));

  // Hex encoding
  test("blocks hex loopback: 0x7f000001 = 127.0.0.1", () =>
    expect(blocked("https://0x7f000001/")).toBe(true));
  test("blocks hex private: 0x0a000001 = 10.0.0.1", () =>
    expect(blocked("https://0x0a000001/")).toBe(true));
  test("blocks hex metadata: 0xa9fea9fe = 169.254.169.254", () =>
    expect(blocked("https://0xa9fea9fe/")).toBe(true));

  // Octal encoding
  test("blocks octal loopback: 0177.0.0.1 = 127.0.0.1", () =>
    expect(blocked("https://0177.0.0.1/")).toBe(true));
  test("blocks octal private: 012.0.0.1 = 10.0.0.1", () =>
    expect(blocked("https://012.0.0.1/")).toBe(true));
});

// ---------------------------------------------------------------------------
// IPv6 blocking
// ---------------------------------------------------------------------------

describe("IPv6 private range blocking", () => {
  // Loopback
  test("blocks [::1] (IPv6 loopback)", () => expect(blocked("https://[::1]/")).toBe(true));
  test("blocks [0:0:0:0:0:0:0:1] (full loopback)", () =>
    expect(blocked("https://[0:0:0:0:0:0:0:1]/")).toBe(true));

  // Link-local fe80::/10
  test("blocks [fe80::1] (link-local)", () => expect(blocked("https://[fe80::1]/")).toBe(true));
  test("blocks [fe80::dead:beef] (link-local)", () =>
    expect(blocked("https://[fe80::dead:beef]/")).toBe(true));
  test("blocks [feb0::1] (link-local range upper)", () =>
    expect(blocked("https://[feb0::1]/")).toBe(true));

  // Unique-local fc00::/7
  test("blocks [fc00::1] (unique-local fc)", () =>
    expect(blocked("https://[fc00::1]/")).toBe(true));
  test("blocks [fd00::1] (unique-local fd)", () =>
    expect(blocked("https://[fd00::1]/")).toBe(true));
  test("blocks [fd00:ec2::254] (AWS IPv6 IMDS)", () =>
    expect(blocked("https://[fd00:ec2::254]/")).toBe(true));
  test("blocks [fdff:ffff:ffff:ffff::1]", () =>
    expect(blocked("https://[fdff:ffff:ffff:ffff::1]/")).toBe(true));

  // IPv4-mapped ::ffff:0:0/96
  test("blocks [::ffff:192.168.0.1] (IPv4-mapped private)", () =>
    expect(blocked("https://[::ffff:192.168.0.1]/")).toBe(true));
  test("blocks [::ffff:127.0.0.1] (IPv4-mapped loopback)", () =>
    expect(blocked("https://[::ffff:127.0.0.1]/")).toBe(true));
  test("blocks [::ffff:10.0.0.1] (IPv4-mapped RFC 1918)", () =>
    expect(blocked("https://[::ffff:10.0.0.1]/")).toBe(true));

  // 6to4 with private IPv4
  test("blocks [2002:0a00:0001::] (6to4 wrapping 10.0.0.1)", () =>
    expect(blocked("https://[2002:0a00:0001::]/")).toBe(true));
  test("blocks [2002:7f00:0001::] (6to4 wrapping 127.0.0.1)", () =>
    expect(blocked("https://[2002:7f00:0001::]/")).toBe(true));
  test("blocks [2002:c0a8:0101::] (6to4 wrapping 192.168.1.1)", () =>
    expect(blocked("https://[2002:c0a8:0101::]/")).toBe(true));

  // 6to4 wrapping a cloud metadata address: 169.254.169.254 = 0xa9fe.0xa9fe
  test("blocks [2002:a9fe:a9fe::] (6to4 wrapping 169.254.169.254)", () =>
    expect(blocked("https://[2002:a9fe:a9fe::]/")).toBe(true));

  // 6to4 wrapping a public IPv4 must be allowed
  test("allows [2002:0102:0304::] (6to4 wrapping public 1.2.3.4)", () =>
    expect(allowed("https://[2002:0102:0304::]/")).toBe(true));

  // Teredo (2001:0000::/32)
  test("blocks [2001:0:4136:e378::8007:8] (Teredo)", () =>
    expect(blocked("https://[2001:0:4136:e378::8007:8]/")).toBe(true));
  test("blocks [2001:0000:4136:e378::8007:8] (Teredo full-form)", () =>
    expect(blocked("https://[2001:0000:4136:e378::8007:8]/")).toBe(true));

  // Global unicast — must be allowed (2001:db8 is documentation, NOT Teredo)
  test("allows [2001:db8::1] (documentation prefix, not Teredo)", () =>
    expect(allowed("https://[2001:db8::1]/")).toBe(true));
  test("allows [2606:4700::1] (Cloudflare)", () =>
    expect(allowed("https://[2606:4700::1]/")).toBe(true));
});

// ---------------------------------------------------------------------------
// Domain allowlist
// ---------------------------------------------------------------------------

describe("domain allowlist", () => {
  test("allows any domain when no allowedDomains configured", () => {
    const cfg = compileNavigationSecurity({});
    expect(allowed("https://anything.example.com", cfg)).toBe(true);
  });

  test("allows exact domain match", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["example.com"] });
    expect(allowed("https://example.com/page", cfg)).toBe(true);
  });

  test("allows exact domain case-insensitively", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["example.com"] });
    expect(allowed("https://EXAMPLE.COM/page", cfg)).toBe(true);
  });

  test("blocks domain not in allowlist", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["example.com"] });
    expect(blocked("https://other.com/", cfg)).toBe(true);
    expect(codeFor("https://other.com/", cfg)).toBe("PERMISSION");
  });

  test("allows wildcard subdomain match", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["*.example.com"] });
    expect(allowed("https://api.example.com/", cfg)).toBe(true);
    expect(allowed("https://cdn.example.com/", cfg)).toBe(true);
  });

  test("wildcard does not match bare domain (*.example.com ≠ example.com)", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["*.example.com"] });
    expect(blocked("https://example.com/", cfg)).toBe(true);
  });

  test("wildcard does not match multi-level subdomains", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["*.example.com"] });
    // deep.api.example.com has two dots before example.com — should be blocked
    expect(blocked("https://deep.api.example.com/", cfg)).toBe(true);
  });

  test("blocked domain error message lists permitted examples", () => {
    const cfg = compileNavigationSecurity({
      allowedDomains: ["allowed1.com", "allowed2.com"],
    });
    const msg = errorFor("https://blocked.com/", cfg);
    expect(msg).toContain("allowed1.com");
    expect(msg).toContain("blocked.com");
  });

  test("domain allowlist + private IP: both checks apply", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["example.com"] });
    // Private IP not in allowlist — blocked by private IP check first
    expect(blocked("https://192.168.1.1/", cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input validation (VALIDATION errors)
// ---------------------------------------------------------------------------

describe("input validation", () => {
  test("returns VALIDATION for missing key", () => {
    const r = parseSecureUrl({}, "url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("VALIDATION");
  });

  test("returns VALIDATION for empty string", () => {
    const r = parseSecureUrl({ url: "" }, "url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("VALIDATION");
  });

  test("returns VALIDATION for relative URL (no scheme)", () => {
    const r = parseSecureUrl({ url: "/path/only" }, "url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("VALIDATION");
  });

  test("returns VALIDATION for non-string type", () => {
    const r = parseSecureUrl({ url: 42 }, "url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("VALIDATION");
  });

  test("returns VALIDATION for malformed URL", () => {
    const r = parseSecureUrl({ url: "not a url at all" }, "url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// Disabling private address blocking
// ---------------------------------------------------------------------------

describe("blockPrivateAddresses: false", () => {
  test("allows private IP when blockPrivateAddresses disabled", () => {
    const cfg = compileNavigationSecurity({ blockPrivateAddresses: false });
    expect(allowed("https://192.168.1.1/", cfg)).toBe(true);
    expect(allowed("https://127.0.0.1/", cfg)).toBe(true);
  });

  test("still enforces protocol allowlist when blockPrivateAddresses disabled", () => {
    const cfg = compileNavigationSecurity({ blockPrivateAddresses: false });
    expect(blocked("file:///etc/passwd", cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSecureOptionalUrl
// ---------------------------------------------------------------------------

describe("parseSecureOptionalUrl", () => {
  const cfg = compileNavigationSecurity();

  test("returns undefined when key absent", () => {
    const r = parseSecureOptionalUrl({}, "url", cfg);
    expect(r).toEqual({ ok: true, value: undefined });
  });

  test("returns undefined for empty string", () => {
    const r = parseSecureOptionalUrl({ url: "" }, "url", cfg);
    expect(r).toEqual({ ok: true, value: undefined });
  });

  test("validates and returns URL when present", () => {
    const r = parseSecureOptionalUrl({ url: "https://example.com" }, "url", cfg);
    expect(r).toEqual({ ok: true, value: "https://example.com" });
  });

  test("applies security checks when URL present", () => {
    const r = parseSecureOptionalUrl({ url: "https://192.168.1.1/" }, "url", cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("PERMISSION");
  });

  test("returns VALIDATION for non-string type", () => {
    const r = parseSecureOptionalUrl({ url: 42 }, "url", cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// AI-friendly error message quality
// ---------------------------------------------------------------------------

describe("AI-friendly denial messages", () => {
  test("private IP message contains the blocked hostname", () => {
    const msg = errorFor("https://10.0.0.1/api");
    expect(msg).toContain("10.0.0.1");
  });

  test("private IP message explains the category", () => {
    const msg = errorFor("https://192.168.1.1/");
    expect(msg).toContain("RFC 1918");
  });

  test("private IP message includes guidance on what to do", () => {
    const msg = errorFor("https://10.0.0.1/");
    expect(msg).toContain("allowedDomains");
  });

  test("protocol message names the disallowed protocol and allowed alternatives", () => {
    const msg = errorFor("file:///etc/passwd");
    expect(msg).toContain("file:");
    expect(msg).toContain("https:");
  });

  test("domain message names the blocked domain", () => {
    const cfg = compileNavigationSecurity({ allowedDomains: ["allowed.com"] });
    const msg = errorFor("https://blocked.com/", cfg);
    expect(msg).toContain("blocked.com");
  });

  test("cloud metadata message conveys credential risk", () => {
    const msg = errorFor("http://169.254.169.254/latest/meta-data/");
    expect(msg).toContain("metadata");
  });

  test("all denial messages use PERMISSION code", () => {
    const cases = [
      "file:///etc/passwd",
      "https://127.0.0.1/",
      "https://192.168.1.1/",
      "http://169.254.169.254/",
      "https://[::1]/",
    ];
    for (const url of cases) {
      expect(codeFor(url)).toBe("PERMISSION");
    }
  });
});

// ---------------------------------------------------------------------------
// Additional edge-case SSRF bypass vectors (Issue 271)
// ---------------------------------------------------------------------------

describe("SSRF bypass edge cases", () => {
  // Userinfo prefix: http://user@169.254.169.254/ — the WHATWG URL parser
  // places 169.254.169.254 in url.hostname regardless of the userinfo prefix.
  test("blocks userinfo prefix: user@169.254.169.254", () => {
    expect(blocked("http://user@169.254.169.254/")).toBe(true);
  });

  // Explicit port should not bypass the IP block — port appears in url.port,
  // hostname is still the private IP and is checked independently.
  test("blocks 169.254.169.254 with explicit port :80", () => {
    expect(blocked("http://169.254.169.254:80/")).toBe(true);
  });

  test("blocks RFC 1918 10.0.0.1 with non-standard port :8080", () => {
    expect(blocked("http://10.0.0.1:8080/api")).toBe(true);
  });

  // Partial hex encoding: 0x7f.0.0.1 — WHATWG URL normalises this to 127.0.0.1
  // before the block list is checked, so no special handling is needed.
  test("blocks partial hex 0x7f.0.0.1 (= 127.0.0.1)", () => {
    expect(blocked("https://0x7f.0.0.1/")).toBe(true);
  });

  // Public IP with explicit port must remain allowed — ports are not a signal
  // of private-ness and should not cause false positives.
  test("allows public IP 8.8.8.8:443 (public with explicit port)", () => {
    expect(allowed("https://8.8.8.8:443/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No security config — backward-compatible passthrough
// ---------------------------------------------------------------------------

describe("no security config (passthrough)", () => {
  test("allows any URL when security is undefined", () => {
    const r = parseSecureUrl({ url: "https://example.com" }, "url", undefined);
    expect(r).toEqual({ ok: true, value: "https://example.com" });
  });

  test("still validates URL syntax even without security config", () => {
    const r = parseSecureUrl({ url: "not-a-url" }, "url", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.code).toBe("VALIDATION");
  });
});
