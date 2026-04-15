/**
 * Text-based rules for dangerous patterns in skill prose (not code blocks).
 *
 * Complements the AST rules, which only see fenced code. Skill bodies can
 * direct an agent to run destructive commands or exfiltrate secrets in plain
 * prose — these patterns catch the common shapes.
 *
 * Only fires when the filename ends with `.md` (text-rule convention).
 */

import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import { offsetToLocation } from "../walker.js";

// ---------------------------------------------------------------------------
// Destructive shell patterns
// ---------------------------------------------------------------------------

const DESTRUCTIVE_SHELL_PATTERNS: readonly RegExp[] = [
  // rm -rf targeting root / home / --no-preserve-root
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*\s+(?:--no-preserve-root\b|\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME\b)/,
  /\brm\s+-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*\s+(?:--no-preserve-root\b|\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME\b)/,
  // Classic fork bomb
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // Format a block device
  /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//,
  // Write raw bytes to a disk device
  /\bdd\s+[^\n]*\bof=\/dev\/[sh]d[a-z]/,
  // Recursive world-writable permissions from root
  /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+0*777\s+\//,
];

function checkDestructiveShell(ctx: ScanContext): readonly ScanFinding[] {
  if (!ctx.filename.endsWith(".md")) return [];

  for (const pattern of DESTRUCTIVE_SHELL_PATTERNS) {
    const match = pattern.exec(ctx.sourceText);
    if (match !== null) {
      return [
        {
          rule: "dangerous-shell-prose",
          severity: "HIGH",
          confidence: 0.85,
          category: "FILESYSTEM_ABUSE",
          message: `Destructive shell command in skill body: "${match[0].trim().slice(0, 60)}"`,
          location: offsetToLocation(ctx.sourceText, match.index),
        },
      ];
    }
  }
  return [];
}

export const destructiveShellProseRule: ScanRule = {
  name: "dangerous-shell-prose",
  category: "FILESYSTEM_ABUSE",
  defaultSeverity: "HIGH",
  check: checkDestructiveShell,
};

// ---------------------------------------------------------------------------
// Credential env-var references
// ---------------------------------------------------------------------------

// Matches $VAR or ${VAR} where VAR contains a credential suffix
// (API_KEY, ACCESS_KEY, SECRET_KEY, AUTH_TOKEN, ACCESS_TOKEN, BEARER_TOKEN,
// PRIVATE_KEY, CLIENT_SECRET, PASSWORD). Skill bodies should never instruct
// the agent to read credential env vars — flag as exfiltration signal.
const CREDENTIAL_ENV_VAR_PATTERN =
  /\$\{?[A-Z][A-Z0-9_]*?(?:API_KEY|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|PRIVATE_KEY|CLIENT_SECRET|PASSWORD)[A-Z0-9_]*\}?\b/;

// Also catch the minimal forms $API_KEY, $PASSWORD, etc.
const MINIMAL_CREDENTIAL_ENV_VAR_PATTERN =
  /\$\{?(?:API_KEY|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|PRIVATE_KEY|CLIENT_SECRET|PASSWORD)\}?\b/;

function checkCredentialEnvReference(ctx: ScanContext): readonly ScanFinding[] {
  if (!ctx.filename.endsWith(".md")) return [];

  const match =
    CREDENTIAL_ENV_VAR_PATTERN.exec(ctx.sourceText) ??
    MINIMAL_CREDENTIAL_ENV_VAR_PATTERN.exec(ctx.sourceText);
  if (match === null) return [];

  return [
    {
      rule: "credential-env-reference",
      severity: "HIGH",
      confidence: 0.75,
      category: "EXFILTRATION",
      message: `Credential environment variable referenced in skill body: "${match[0].trim().slice(0, 60)}"`,
      location: offsetToLocation(ctx.sourceText, match.index),
    },
  ];
}

export const credentialEnvReferenceRule: ScanRule = {
  name: "credential-env-reference",
  category: "EXFILTRATION",
  defaultSeverity: "HIGH",
  check: checkCredentialEnvReference,
};
