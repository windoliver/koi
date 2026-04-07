/**
 * Rule: ssrf
 *
 * Detects Server-Side Request Forgery patterns: fetch/http calls to
 * cloud metadata endpoints, private RFC 1918 networks, and loopback addresses.
 */

import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import {
  getCalleeAsMemberPath,
  getCalleeName,
  getStringValue,
  offsetToLocation,
  visitAst,
} from "../walker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUD_METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0"]);

const NETWORK_CALL_NAMES = new Set(["fetch"]);

const NETWORK_CONSTRUCTOR_NAMES = new Set(["WebSocket", "XMLHttpRequest"]);

const NETWORK_MEMBER_APIS = new Set(["http.request", "http.get", "https.request", "https.get"]);

// ---------------------------------------------------------------------------
// Hostname classification
// ---------------------------------------------------------------------------

function extractHostname(urlString: string): string | undefined {
  try {
    // Normalize ws:// and wss:// to http:// and https:// for URL parsing
    const normalized = urlString.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
    const url = new URL(normalized.startsWith("//") ? `https:${normalized}` : normalized);
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLoopbackIp(host: string): boolean {
  return /^127\./.test(host);
}

function isIpv6Loopback(host: string): boolean {
  return host === "::1" || host === "[::1]";
}

function isPrivateRfc1918(host: string): boolean {
  if (/^10\./.test(host)) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m !== null) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (/^192\.168\./.test(host)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// IP encoding deobfuscation (bypass detection)
// ---------------------------------------------------------------------------

/** Convert a decimal integer IP (e.g. "2130706433") to dotted quad ("127.0.0.1"). */
function decimalToIp(host: string): string | undefined {
  if (!/^\d+$/.test(host)) return undefined;
  const n = Number(host);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return undefined;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/** Convert a hex IP (e.g. "0x7f000001") to dotted quad ("127.0.0.1"). */
function hexToIp(host: string): string | undefined {
  if (!/^0x[0-9a-f]+$/i.test(host)) return undefined;
  const n = Number(host);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return undefined;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/** Convert an octal-dotted IP (e.g. "0177.0.0.1") to dotted quad ("127.0.0.1"). */
function octalToIp(host: string): string | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  // At least one octet must use octal notation (leading 0)
  const hasOctal = parts.some((p) => p.length > 1 && p.startsWith("0") && /^0[0-7]+$/.test(p));
  if (!hasOctal) return undefined;
  const octets = parts.map((p) => {
    if (p.length > 1 && p.startsWith("0")) return Number.parseInt(p, 8);
    return Number.parseInt(p, 10);
  });
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return undefined;
  return octets.join(".");
}

/** Try to decode an encoded IP, returns dotted quad or undefined. */
function deobfuscateIp(host: string): string | undefined {
  return decimalToIp(host) ?? hexToIp(host) ?? octalToIp(host);
}

interface SsrfClassification {
  readonly severity: "CRITICAL" | "HIGH";
  readonly confidence: number;
  readonly label: string;
}

function classifyDottedHost(host: string): SsrfClassification | undefined {
  if (CLOUD_METADATA_HOSTS.has(host)) {
    return { severity: "CRITICAL", confidence: 0.95, label: "cloud metadata endpoint" };
  }
  if (isPrivateRfc1918(host)) {
    return { severity: "HIGH", confidence: 0.85, label: "private RFC 1918 network" };
  }
  if (isLoopbackIp(host) || LOOPBACK_HOSTS.has(host)) {
    return { severity: "HIGH", confidence: 0.8, label: "loopback address" };
  }
  if (isIpv6Loopback(host)) {
    return { severity: "HIGH", confidence: 0.75, label: "IPv6 loopback address" };
  }
  return undefined;
}

function classifyHost(host: string): SsrfClassification | undefined {
  const direct = classifyDottedHost(host);
  if (direct !== undefined) return direct;

  // Try IP encoding bypass detection (decimal, hex, octal)
  const decoded = deobfuscateIp(host);
  if (decoded === undefined) return undefined;

  const decodedResult = classifyDottedHost(decoded);
  if (decodedResult === undefined) return undefined;

  // Encoded IPs are always HIGH confidence — deliberate evasion
  return {
    severity: decodedResult.severity,
    confidence: 0.9,
    label: `encoded ${decodedResult.label}`,
  };
}

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];

  function checkUrlArg(urlValue: string, nodeStart: number): void {
    const host = extractHostname(urlValue);
    if (host === undefined) return;

    const classification = classifyHost(host);
    if (classification === undefined) return;

    const loc = offsetToLocation(ctx.sourceText, nodeStart);
    findings.push({
      rule: "ssrf:internal-network",
      severity: classification.severity,
      confidence: classification.confidence,
      category: "SSRF",
      message: `Request to ${classification.label} (${host}) — potential SSRF`,
      location: loc,
    });
  }

  visitAst(ctx.program, {
    onCallExpression(node) {
      const callee = getCalleeName(node);
      const memberPath = getCalleeAsMemberPath(node);

      const isNetworkCall =
        (callee !== undefined && NETWORK_CALL_NAMES.has(callee)) ||
        (memberPath !== undefined && NETWORK_MEMBER_APIS.has(memberPath));

      if (!isNetworkCall) return;

      const firstArg = node.arguments[0];
      if (firstArg === undefined) return;
      const urlValue = getStringValue(firstArg);
      if (urlValue === undefined) return;

      checkUrlArg(urlValue, node.start);
    },

    onNewExpression(node) {
      if (node.callee.type !== "Identifier") return;
      if (!NETWORK_CONSTRUCTOR_NAMES.has(node.callee.name)) return;

      const firstArg = node.arguments[0];
      if (firstArg === undefined) return;
      const urlValue = getStringValue(firstArg);
      if (urlValue === undefined) return;

      checkUrlArg(urlValue, node.start);
    },
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const ssrfRule: ScanRule = {
  name: "ssrf",
  category: "SSRF",
  defaultSeverity: "HIGH",
  check,
};
