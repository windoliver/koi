import { MAX_INPUT_LENGTH, matchPatterns } from "./match.js";
import type { ClassificationResult, ThreatPattern } from "./types.js";

/**
 * Obfuscation signals that must be detected on the RAW pre-normalization
 * input. `normalizeForMatch` decodes `$'\x72\x6d'` into `rm`, which is the
 * correct behavior for destructive classification but erases the "this input
 * uses an obfuscation encoding" signal. These patterns preserve that signal.
 */
const RAW_OBFUSCATION_PATTERNS: readonly ThreatPattern[] = [
  {
    // ANSI-C hex/octal/unicode escapes like $'\x72\x6d' / $'rm' /
    // $'\U00000072\U0000006d' obfuscate dangerous commands
    regex: /\$'(?:\\x[0-9a-fA-F]{2}|\\[0-7]{3}|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})/,
    category: "injection",
    reason: "Hex/octal/unicode-escaped ANSI-C string can obfuscate shell commands",
  },
  {
    // Null bytes can bypass naive string-boundary security checks
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — security pattern detects null byte injection
    regex: /\u0000/,
    category: "injection",
    reason: "Null byte can bypass string-based security checks",
  },
  {
    // Unicode escape sequences (rm) obfuscate commands
    regex: /\\u00[0-9a-fA-F]{2}/,
    category: "injection",
    reason: "Unicode escape sequences can obfuscate shell commands",
  },
] as const;

/**
 * Injection patterns — compiled once at module load. Applied to NORMALIZED
 * input, so obfuscation forms like `$'\x72\x6d'` have already been decoded
 * before these patterns run. Raw-input obfuscation detection lives in
 * RAW_OBFUSCATION_PATTERNS above.
 *
 * Covers: eval, source/. at command position, base64-decode-to-shell, and
 * directory traversal. Intentionally excludes $() and backticks — those are
 * standard shell features used in legitimate scripts; the bash-classifier
 * handles the dangerous higher-level patterns that use them.
 */
const INJECTION_PATTERNS: readonly ThreatPattern[] = [
  {
    // eval executes arbitrary strings as shell code — no legitimate agent use case
    regex: /\beval\b/,
    category: "injection",
    reason: "eval executes arbitrary strings as shell code",
  },
  {
    // source / dot-command executes arbitrary scripts from the filesystem.
    // Lookbehind excludes the common false-positive contexts: preceding word
    // chars (e.g. `--source`), `.` (path component like `.ssh` or a quoted
    // sentence-period), or `-` (flag continuation). Every legitimate command
    // position — `^`, whitespace, `;`, `|`, `&`, `(`, `$(`, `{`, `!`, reserved
    // words like `if`/`then`/`else` — has either nothing before or a non
    // [\w.-] character before the `source`/`.`, so it matches.
    // The trailing alternation matches either `\s+\S` (regular `source /path`)
    // OR an immediately-adjacent `$VAR`/backtick expansion. The latter covers
    // the `source$IFS/path` and `.${IFS}/path` bypass — bash word-splits $IFS
    // into whitespace before the builtin runs, so `source$IFS/path` executes
    // as `source /path`. We can't tell at classify time what $IFS expands to,
    // so any expansion adjacent to source/dot is treated as unsafe.
    regex: /(?<![\w.-])(?:source|\.)(?:\s+\S|\$[A-Za-z_{(]|`)/,
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
] as const;

/**
 * Detect command injection patterns in a shell command string.
 *
 * Two-phase scan:
 *   1. Raw-input obfuscation detection (hex/octal ANSI-C, null bytes, Unicode
 *      escape sequences). These signals disappear after normalization decodes
 *      them, so they must run against the original input.
 *   2. Normalized pattern matching for everything else (eval, source at
 *      command position, base64-pipe-sh, directory traversal).
 */
export function detectInjection(command: string): ClassificationResult {
  if (command.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      reason: `Input exceeds ${MAX_INPUT_LENGTH} chars; reject to avoid regex-DoS`,
      pattern: `length:${command.length}`,
      category: "injection",
    };
  }
  for (const { regex, category, reason } of RAW_OBFUSCATION_PATTERNS) {
    if (regex.test(command)) {
      return { ok: false, reason, pattern: regex.source, category };
    }
  }
  return matchPatterns(command, INJECTION_PATTERNS);
}
