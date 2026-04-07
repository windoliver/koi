/**
 * Rule: secrets
 *
 * Detects hardcoded secrets in string literals: AWS keys, GitHub tokens,
 * Slack tokens, private keys, and generic API key assignments.
 */

import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import { getStringValue, offsetToLocation, visitAst } from "../walker.js";

// ---------------------------------------------------------------------------
// Secret patterns — compiled once at module scope
// ---------------------------------------------------------------------------

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
  readonly confidence: number;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // AWS Access Key ID — always exactly AKIA + 16 uppercase alphanumeric
  {
    name: "secrets:aws-access-key",
    pattern: /AKIA[0-9A-Z]{16}/,
    severity: "CRITICAL",
    confidence: 0.95,
  },
  // GitHub Personal Access Token (classic + fine-grained)
  {
    name: "secrets:github-token",
    pattern: /gh[ps]_[A-Za-z0-9_]{36,}/,
    severity: "CRITICAL",
    confidence: 0.95,
  },
  // GitHub OAuth App Token
  {
    name: "secrets:github-oauth",
    pattern: /gho_[A-Za-z0-9_]{36,}/,
    severity: "CRITICAL",
    confidence: 0.9,
  },
  // Slack Bot / User / Workspace token
  {
    name: "secrets:slack-token",
    pattern: /xox[bporas]-[A-Za-z0-9-]{10,}/,
    severity: "CRITICAL",
    confidence: 0.9,
  },
  // PEM private key header
  {
    name: "secrets:private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    severity: "CRITICAL",
    confidence: 0.95,
  },
  // Anthropic API Key
  {
    name: "secrets:anthropic-key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
    severity: "CRITICAL",
    confidence: 0.95,
  },
  // OpenAI API Key (exclude sk-ant- which is Anthropic)
  {
    name: "secrets:openai-key",
    pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/,
    severity: "HIGH",
    confidence: 0.8,
  },
  // Stripe Secret Key
  {
    name: "secrets:stripe-key",
    pattern: /sk_live_[A-Za-z0-9]{20,}/,
    severity: "CRITICAL",
    confidence: 0.95,
  },
  // Generic high-entropy "key = value" or "secret = value" in string
  {
    name: "secrets:generic-api-key",
    pattern:
      /(?:api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}["']/i,
    severity: "MEDIUM",
    confidence: 0.5,
  },
];

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];
  // Track which pattern names already matched to avoid duplicates
  const matched = new Set<string>();

  visitAst(ctx.program, {
    onStringLiteral(node) {
      const value = getStringValue(node);
      if (value === undefined || value.length < 10) return;

      for (const sp of SECRET_PATTERNS) {
        if (matched.has(sp.name)) continue;
        if (sp.pattern.test(value)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: sp.name,
            severity: sp.severity,
            confidence: sp.confidence,
            category: "SECRETS",
            message: `Hardcoded secret detected (${sp.name.replace("secrets:", "")})`,
            location: loc,
          });
          matched.add(sp.name);
        }
      }
    },
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const secretsRule: ScanRule = {
  name: "secrets",
  category: "SECRETS",
  defaultSeverity: "CRITICAL",
  check,
};
