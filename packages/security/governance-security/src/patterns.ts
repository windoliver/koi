import type { RiskLevel } from "@koi/core";

export interface PatternRule {
  readonly pattern: RegExp;
  readonly description: string;
  readonly riskLevel: RiskLevel;
}

export const BUILTIN_RULES: readonly PatternRule[] = [
  // SQL injection
  {
    pattern: /'\s*;\s*(DROP|ALTER|CREATE|TRUNCATE|DELETE|INSERT|UPDATE)\b/i,
    description: "SQL DDL/DML injection after quote",
    riskLevel: "critical",
  },
  {
    pattern: /'\s*(?:OR|AND)\s+(?:'[^']*'|\d+|TRUE|FALSE)\s*=\s*(?:'[^']*'|\d+|TRUE|FALSE)/i,
    description: "SQL tautology injection (OR/AND 1=1)",
    riskLevel: "high",
  },
  {
    pattern: /\bUNION\s+(?:ALL\s+)?SELECT\b/i,
    description: "SQL UNION SELECT data exfiltration",
    riskLevel: "high",
  },
  {
    pattern: /'\s*--\s/,
    description: "SQL comment truncation after quote",
    riskLevel: "high",
  },
  // Command injection
  {
    pattern: /[;&|`]\s*(?:rm|del|format|mkfs|dd|shutdown|halt|reboot)\b/i,
    description: "Dangerous shell command after metacharacter",
    riskLevel: "critical",
  },
  {
    pattern: /\|\s*(?:bash|sh|zsh|csh|fish|cmd\.exe|powershell|pwsh)\b/i,
    description: "Pipe to shell interpreter",
    riskLevel: "critical",
  },
  {
    pattern: /\$\([^)]*\)/,
    description: "Shell command substitution $()",
    riskLevel: "high",
  },
  {
    pattern: /`[^`]+`/,
    description: "Shell backtick command substitution",
    riskLevel: "high",
  },
  {
    pattern: /&&\s*(?:curl|wget|fetch)\s+https?:/i,
    description: "Chained network download after command",
    riskLevel: "high",
  },
  // Path traversal
  {
    pattern: /(?:\.\.[\\/]){2,}/,
    description: "Path traversal via repeated ../ sequences",
    riskLevel: "high",
  },
  {
    pattern: /\/etc\/(?:passwd|shadow|sudoers|crontab|ssh)\b/i,
    description: "Access to sensitive Unix system file",
    riskLevel: "critical",
  },
  {
    pattern: /\/proc\/(?:self|[0-9]+)\//i,
    description: "Access to /proc virtual filesystem",
    riskLevel: "high",
  },
  {
    pattern: /%2e%2e%2f|%2e%2e\/|\.\.%2f/i,
    description: "URL-encoded path traversal",
    riskLevel: "high",
  },
  // Prompt injection
  {
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|context|directions?)\b/i,
    description: "Prompt injection: instruction override attempt",
    riskLevel: "high",
  },
  {
    pattern: /<\|(?:im_start|im_end|system)\|>/,
    description: "Prompt injection: special token injection",
    riskLevel: "high",
  },
  {
    pattern: /\[(?:SYSTEM|INST|CONTEXT)\]/,
    description: "Prompt injection: bracket-delimited role override",
    riskLevel: "high",
  },
];
