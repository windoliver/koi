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

// Credential suffix fragment — any A-Z_ sequence ending in one of these
// tokens is treated as a credential reference. Kept broad enough to catch
// `OPENROUTER_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`,
// `SLACK_TOKEN`, etc., while narrow enough that `$HOME` / `$PATH` / `$USER`
// and identifiers like `TOKENIZER` / `KEY_VALUE_STORE` do not match. The
// trailing negative lookahead `(?![A-Z0-9_])` anchors the fragment to a
// word boundary so `TOKEN` does not match `TOKENIZER`.
const CREDENTIAL_NAME_FRAGMENT =
  "(?:API_KEY|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|PRIVATE_KEY|CLIENT_SECRET|PASSWORD|TOKEN)";
const CREDENTIAL_NAME_BROAD = `[A-Z0-9_]*${CREDENTIAL_NAME_FRAGMENT}(?![A-Z0-9_])`;

// Matches $VAR or ${VAR} where VAR contains a credential suffix.
const CREDENTIAL_ENV_VAR_PATTERN = new RegExp(`\\$\\{?${CREDENTIAL_NAME_BROAD}\\}?\\b`);

// printenv/env|grep <NAME> — shell forms that read credentials without
// the `$` prefix. Intentionally excludes `export` (assignment / setup) and
// `unset` (cleanup) so that benign setup docs like
// `export OPENAI_API_KEY=...` are not quarantined at discovery.
const SHELL_PRINTENV_PATTERN = new RegExp(
  `\\b(?:printenv|env\\s*\\|\\s*grep)\\s+["']?${CREDENTIAL_NAME_BROAD}\\b`,
  "i",
);

// Node.js: process.env.NAME / process.env["NAME"] / process.env['NAME']
const PROCESS_ENV_PATTERN = new RegExp(
  `\\bprocess\\.env(?:\\.${CREDENTIAL_NAME_BROAD}\\b|\\[\\s*["']${CREDENTIAL_NAME_BROAD}["']\\s*\\])`,
);

// Bun: Bun.env.NAME / Bun.env["NAME"] / Bun.env['NAME']. Bun is a
// first-class runtime in this codebase, and the AST exfiltration rule
// only reports standalone `Bun.env` access at LOW unless it is
// correlated with an outbound network call, so this text rule has to
// cover it directly.
const BUN_ENV_PATTERN = new RegExp(
  `\\bBun\\.env(?:\\.${CREDENTIAL_NAME_BROAD}\\b|\\[\\s*["']${CREDENTIAL_NAME_BROAD}["']\\s*\\])`,
);

// Python: os.environ["NAME"] / os.environ.get("NAME") / os.getenv("NAME")
const PYTHON_ENV_PATTERN = new RegExp(
  `\\bos\\.(?:environ(?:\\[\\s*["']${CREDENTIAL_NAME_BROAD}["']\\s*\\]|\\.get\\(\\s*["']${CREDENTIAL_NAME_BROAD}["']\\s*\\))|getenv\\(\\s*["']${CREDENTIAL_NAME_BROAD}["']\\s*\\))`,
);

// C/Go-style getenv("NAME")
const GETENV_CALL_PATTERN = new RegExp(
  `\\bgetenv\\s*\\(\\s*["']${CREDENTIAL_NAME_BROAD}["']\\s*\\)`,
  "i",
);

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  CREDENTIAL_ENV_VAR_PATTERN,
  SHELL_PRINTENV_PATTERN,
  PROCESS_ENV_PATTERN,
  BUN_ENV_PATTERN,
  PYTHON_ENV_PATTERN,
  GETENV_CALL_PATTERN,
];

// Exfiltration intent signals — hostile language or active data-upload
// commands near a credential reference upgrade the finding to HIGH.
//
// Deliberately does NOT include bare non-allowlisted URLs — a skill
// instructing `curl -H "Authorization: Bearer $API_KEY" https://api.internal.corp/...`
// is legitimate private-service usage, not exfiltration. Only patterns
// with clearly hostile semantics (outbound data movement words, attacker
// mention, POST-with-data curl/wget flags) qualify.
const EXFIL_INTENT_PATTERNS: readonly RegExp[] = [
  /\bexfiltrat/i,
  /\battacker\b/i,
  /\b(?:send|post|upload|leak|transmit|forward|ship|deliver)\b[^\n.]{0,80}\b(?:to|via|into)\b/i,
  /\bcurl\s+-[a-zA-Z]*[dX]/i, // curl -d (POST data) / curl -X POST
  /\bwget\s+[^\n]*--post/i,
  // fetch() with method: "POST" + body — active outbound data upload
  /\bfetch\s*\([^\n]*\bmethod\s*:\s*["']POST["'][^\n]*\bbody\s*:/i,
];

function hasExfiltrationIntent(text: string, credentialIndex: number): boolean {
  // Look within a ±400 character window of the credential reference —
  // large enough to span a few sentences or adjacent code lines without
  // false-matching signals elsewhere in the document.
  const WINDOW = 400;
  const start = Math.max(0, credentialIndex - WINDOW);
  const end = Math.min(text.length, credentialIndex + WINDOW);
  const slice = text.slice(start, end);
  for (const pattern of EXFIL_INTENT_PATTERNS) {
    if (pattern.test(slice)) return true;
  }
  return false;
}

function checkCredentialEnvReference(ctx: ScanContext): readonly ScanFinding[] {
  if (!ctx.filename.endsWith(".md")) return [];

  // Scan the full markdown — including fenced code blocks. A malicious
  // skill could otherwise hide `echo $OPENAI_API_KEY` or
  // `process.env.GITHUB_TOKEN` inside a ```bash / ```js block and slip
  // past the prose pass entirely, since the AST scanner skips shell
  // languages and does not cover bare env-var reads in JS/Python.
  //
  // Two-severity gate: a bare credential reference is only MEDIUM
  // (routed through `onSecurityFinding` for observability, not blocking
  // at the default HIGH threshold). A credential reference near an
  // exfiltration-intent signal (URL, curl/fetch with a non-allowlisted
  // host, "send/leak/exfiltrate") upgrades to HIGH and blocks at
  // discovery time. Benign skill docs that simply show how to read an
  // API key thus stay shippable; skills whose body explicitly instructs
  // the agent to ship the secret elsewhere are quarantined.
  //
  // Crucially we must scan ALL credential occurrences, not just the
  // first — otherwise an attacker could precede the real payload with a
  // harmless `$OPENAI_API_KEY` mention and downgrade the whole document
  // to MEDIUM. We iterate every global match across every pattern and
  // promote to HIGH as soon as one has exfiltration intent.
  let firstMediumMatch: { readonly index: number; readonly text: string } | undefined;
  for (const pattern of CREDENTIAL_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    for (const match of ctx.sourceText.matchAll(globalPattern)) {
      const index = match.index ?? 0;
      const matchText = match[0] ?? "";
      if (hasExfiltrationIntent(ctx.sourceText, index)) {
        return [
          {
            rule: "credential-env-reference",
            severity: "HIGH",
            confidence: 0.85,
            category: "EXFILTRATION",
            message: `Credential environment variable referenced near exfiltration intent: "${matchText.trim().slice(0, 60)}"`,
            location: offsetToLocation(ctx.sourceText, index),
          },
        ];
      }
      if (firstMediumMatch === undefined) {
        firstMediumMatch = { index, text: matchText };
      }
    }
  }
  if (firstMediumMatch === undefined) return [];
  return [
    {
      rule: "credential-env-reference",
      severity: "MEDIUM",
      confidence: 0.6,
      category: "EXFILTRATION",
      message: `Credential environment variable referenced in skill body: "${firstMediumMatch.text.trim().slice(0, 60)}"`,
      location: offsetToLocation(ctx.sourceText, firstMediumMatch.index),
    },
  ];
}

export const credentialEnvReferenceRule: ScanRule = {
  name: "credential-env-reference",
  category: "EXFILTRATION",
  defaultSeverity: "HIGH",
  check: checkCredentialEnvReference,
};
