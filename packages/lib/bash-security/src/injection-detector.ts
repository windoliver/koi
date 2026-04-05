import { matchPatterns } from "./match.js";
import type { ClassificationResult, ThreatPattern } from "./types.js";

/**
 * Injection patterns — compiled once at module load.
 *
 * Covers: eval, base64-decode-to-shell pipelines, hex-escaped ANSI-C strings,
 * null byte injection, and Unicode escape obfuscation.
 *
 * Intentionally excludes $() and backticks — those are standard shell features
 * used heavily in legitimate scripts. The bash-classifier covers the dangerous
 * higher-level patterns that use them (reverse shells, etc.).
 */
const INJECTION_PATTERNS: readonly ThreatPattern[] = [
  {
    // eval executes arbitrary strings as shell code — no legitimate agent use case
    regex: /\beval\b/,
    category: "injection",
    reason: "eval executes arbitrary strings as shell code",
  },
  {
    // source / dot-command executes arbitrary scripts from the filesystem
    regex: /\bsource\b|\.\s+\S/,
    category: "injection",
    reason: "source/. executes an arbitrary script file",
  },
  {
    // base64 decode piped to a shell executes obfuscated remote code
    regex: /\bbase64\b[^|#\n]*\|\s*(ba)?sh\b/,
    category: "injection",
    reason: "base64 decode piped to shell executes obfuscated commands",
  },
  {
    // Directory traversal sequences in the command body attempt filesystem escape.
    // Absolute paths should be used instead; ../ in a command arg accesses files
    // outside the working directory without explicit operator knowledge.
    regex: /\.\.(\/|\\)/,
    category: "injection",
    reason: "Directory traversal sequence (../) in command can access files outside workspace",
  },
  {
    // ANSI-C hex-escaped strings like $'\x72\x6d' obfuscate dangerous commands
    regex: /\$'(\\x[0-9a-fA-F]{2}|\\[0-7]{3})/,
    category: "injection",
    reason: "Hex/octal-escaped ANSI-C string can obfuscate shell commands",
  },
  {
    // Null bytes can bypass naive string-boundary security checks
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — security pattern detects null byte injection
    regex: /\u0000/,
    category: "injection",
    reason: "Null byte can bypass string-based security checks",
  },
  {
    // Unicode escape sequences (\u0072\u006d) obfuscate commands
    regex: /\\u00[0-9a-fA-F]{2}/,
    category: "injection",
    reason: "Unicode escape sequences can obfuscate shell commands",
  },
] as const;

/**
 * Detect command injection patterns in a shell command string.
 * Returns the first match found with full diagnostic context.
 */
export function detectInjection(command: string): ClassificationResult {
  return matchPatterns(command, INJECTION_PATTERNS);
}
