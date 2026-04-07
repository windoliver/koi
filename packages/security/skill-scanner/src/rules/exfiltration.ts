/**
 * Rule: exfiltration
 *
 * Detects data exfiltration patterns: fetch/http + env access,
 * DNS exfiltration, encoding + network calls, and env variable access.
 */

import type { ScanContext, ScanFinding, ScannerConfig, ScanRule } from "../types.js";
import {
  getCalleeAsMemberPath,
  getCalleeName,
  getStringValue,
  isStringLiteralNode,
  offsetToLocation,
  visitAst,
} from "../walker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NETWORK_APIS = new Set(["fetch", "XMLHttpRequest", "WebSocket"]);

const DEFAULT_TRUSTED_DOMAINS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "api.github.com",
  "api.stripe.com",
]);

const trustedDomainsCache = new WeakMap<ScannerConfig, ReadonlySet<string>>();

function buildTrustedDomains(config?: ScannerConfig): ReadonlySet<string> {
  if (config === undefined) return DEFAULT_TRUSTED_DOMAINS;
  const cached = trustedDomainsCache.get(config);
  if (cached !== undefined) return cached;
  const userDomains = config.trustedDomains ?? [];
  if (userDomains.length === 0) {
    trustedDomainsCache.set(config, DEFAULT_TRUSTED_DOMAINS);
    return DEFAULT_TRUSTED_DOMAINS;
  }
  const merged = new Set([...DEFAULT_TRUSTED_DOMAINS, ...userDomains]);
  trustedDomainsCache.set(config, merged);
  return merged;
}

const NETWORK_MEMBER_APIS = new Set([
  "http.request",
  "http.get",
  "https.request",
  "https.get",
  "dns.lookup",
  "dns.resolve",
]);

const ENCODING_APIS = new Set(["btoa", "atob"]);

const ENCODING_MEMBER_APIS = new Set(["Buffer.from"]);

// ---------------------------------------------------------------------------
// Domain allowlisting
// ---------------------------------------------------------------------------

function isTrustedUrl(url: string, trustedDomains: ReadonlySet<string>): boolean {
  for (const domain of trustedDomains) {
    for (const scheme of ["https://", "http://"]) {
      const prefix = `${scheme}${domain}`;
      if (url.startsWith(prefix)) {
        const charAfter = url[prefix.length];
        // Domain boundary: end-of-string, path, query, port, or fragment
        // Note: '@' is deliberately excluded — api.openai.com@evil.com must NOT match
        if (
          charAfter === undefined ||
          charAfter === "/" ||
          charAfter === "?" ||
          charAfter === ":" ||
          charAfter === "#"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];
  const trustedDomains = buildTrustedDomains(ctx.config);

  // let: correlation flags accumulated across visitor callbacks
  let hasUntrustedNetworkCall = false;
  let hasEnvAccess = false;
  let hasEncodingCall = false;
  let untrustedNetworkCallOffset = -1;
  let envAccessOffset = -1;

  visitAst(ctx.program, {
    onCallExpression(node) {
      const callee = getCalleeName(node);

      // Network API calls — track first occurrence and trust status
      if (callee !== undefined && NETWORK_APIS.has(callee)) {
        const firstArg = node.arguments[0];
        const urlLiteral =
          firstArg !== undefined && isStringLiteralNode(firstArg) ? firstArg.value : undefined;
        if (urlLiteral === undefined || !isTrustedUrl(urlLiteral, trustedDomains)) {
          if (!hasUntrustedNetworkCall) untrustedNetworkCallOffset = node.start;
          hasUntrustedNetworkCall = true;
        }
      }

      // Encoding calls
      if (callee !== undefined && ENCODING_APIS.has(callee)) {
        hasEncodingCall = true;
      }

      // Member-based network APIs
      const memberPath = getCalleeAsMemberPath(node);
      if (memberPath !== undefined) {
        if (NETWORK_MEMBER_APIS.has(memberPath)) {
          // Member-based network calls are always untrusted (no static URL argument)
          if (!hasUntrustedNetworkCall) untrustedNetworkCallOffset = node.start;
          hasUntrustedNetworkCall = true;

          // DNS exfiltration: dns.lookup with variable subdomain
          if (memberPath === "dns.lookup" || memberPath === "dns.resolve") {
            const firstArg = node.arguments[0];
            if (firstArg !== undefined && getStringValue(firstArg) === undefined) {
              // Non-literal DNS lookup target — potential exfiltration
              const loc = offsetToLocation(ctx.sourceText, node.start);
              findings.push({
                rule: "exfiltration:dns-exfil",
                severity: "CRITICAL",
                confidence: 0.85,
                category: "EXFILTRATION",
                message: `${memberPath}() with dynamic argument — potential DNS exfiltration`,
                location: loc,
              });
            }
          }
        }

        if (ENCODING_MEMBER_APIS.has(memberPath)) {
          hasEncodingCall = true;
        }
      }
    },

    onNewExpression(node) {
      // new WebSocket(...), new XMLHttpRequest()
      if (node.callee.type === "Identifier" && NETWORK_APIS.has(node.callee.name)) {
        // Constructor-based network calls are always untrusted
        if (!hasUntrustedNetworkCall) untrustedNetworkCallOffset = node.start;
        hasUntrustedNetworkCall = true;
      }

      // new Image().src pattern (detected at assignment level)
      if (node.callee.type === "Identifier" && node.callee.name === "Image") {
        if (!hasUntrustedNetworkCall) untrustedNetworkCallOffset = node.start;
        hasUntrustedNetworkCall = true;
      }
    },

    onMemberExpression(node) {
      // process.env access
      if (!node.computed && node.object.type === "Identifier" && node.object.name === "process") {
        const prop = node.property;
        if ("name" in prop && prop.name === "env") {
          if (!hasEnvAccess) envAccessOffset = node.start;
          hasEnvAccess = true;
        }
      }

      // Bun.env access
      if (!node.computed && node.object.type === "Identifier" && node.object.name === "Bun") {
        const prop = node.property;
        if ("name" in prop && prop.name === "env") {
          if (!hasEnvAccess) envAccessOffset = node.start;
          hasEnvAccess = true;
        }
      }
    },
  });

  // Correlation: untrusted network call + env access in same code unit
  if (hasUntrustedNetworkCall && hasEnvAccess) {
    const loc = offsetToLocation(ctx.sourceText, untrustedNetworkCallOffset);
    findings.push({
      rule: "exfiltration:network-env",
      severity: "HIGH",
      confidence: 0.8,
      category: "EXFILTRATION",
      message:
        "Network API call combined with environment variable access — potential data exfiltration",
      location: loc,
    });
  }

  // Correlation: encoding + untrusted network call (base64 encode then send)
  if (hasEncodingCall && hasUntrustedNetworkCall) {
    const loc = offsetToLocation(ctx.sourceText, untrustedNetworkCallOffset);
    findings.push({
      rule: "exfiltration:encoding-network",
      severity: "MEDIUM",
      confidence: 0.6,
      category: "EXFILTRATION",
      message: "Encoding function combined with network call — potential encoded exfiltration",
      location: loc,
    });
  }

  // Standalone env access (informational — low severity, only when no untrusted network call)
  if (hasEnvAccess && !hasUntrustedNetworkCall) {
    const loc = offsetToLocation(ctx.sourceText, envAccessOffset);
    findings.push({
      rule: "exfiltration:env-access",
      severity: "LOW",
      confidence: 0.3,
      category: "EXFILTRATION",
      message: "Environment variable access detected (process.env or Bun.env)",
      location: loc,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const exfiltrationRule: ScanRule = {
  name: "exfiltration",
  category: "EXFILTRATION",
  defaultSeverity: "HIGH",
  check,
};
