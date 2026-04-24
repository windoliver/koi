/**
 * `classifyCommand(cmdLine)` — structural classification entry point.
 *
 * Pipeline:
 *   1. Tokenize on whitespace.
 *   2. Compute canonical permission prefix via `ARITY` table.
 *   3. Test every `DANGEROUS_PATTERNS` entry against the raw string.
 *   4. Aggregate worst severity.
 *
 * Pure function. No I/O. No side effects.
 */

import { DANGEROUS_PATTERNS } from "./patterns.js";
import {
  extractNestedShellCommand,
  extractShellDashCArgFromTokens,
  normalizeTokens,
  prefix,
  shellTokenize,
} from "./prefix.js";
import type { ClassifyResult, DangerousPattern, Severity } from "./types.js";

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function worstSeverity(patterns: readonly DangerousPattern[]): Severity | null {
  if (patterns.length === 0) return null;
  let worst: Severity = patterns[0]?.severity ?? "low";
  for (const p of patterns) {
    if (SEVERITY_ORDER[p.severity] > SEVERITY_ORDER[worst]) {
      worst = p.severity;
    }
  }
  return worst;
}

function tokenize(cmdLine: string): readonly string[] {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return [];
  // Shell-aware: preserves `FOO='x y'` as a single token, collapses
  // adjacent-quote obfuscation (`py''thon`) into `python`. Naive
  // whitespace split fragments these forms and produces a wrong
  // `prefix` for the exported ClassifyResult.
  return shellTokenize(trimmed);
}

/**
 * Return the character ranges (start-inclusive, end-inclusive) of
 * quoted regions in the command line. Used to reject structural
 * pattern matches that land entirely inside a quoted arg.
 */
function quoteRanges(s: string): readonly [number, number][] {
  const ranges: [number, number][] = [];
  let quote: "'" | '"' | null = null;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote !== null) {
      if (c === "\\" && quote === '"' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === quote) {
        ranges.push([start, i]);
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      start = i;
    }
  }
  return ranges;
}

function isInsideQuote(pos: number, ranges: readonly [number, number][]): boolean {
  for (const [a, b] of ranges) {
    if (pos >= a && pos <= b) return true;
  }
  return false;
}

/**
 * Return the index of the first regex match that falls OUTSIDE any
 * quoted region in `s`, or `-1` if the pattern does not match in
 * unquoted text.
 */
function firstUnquotedMatch(regex: RegExp, s: string, ranges: readonly [number, number][]): number {
  const clone = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
  );
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec loop
  while ((m = clone.exec(s)) !== null) {
    if (!isInsideQuote(m.index, ranges)) return m.index;
    if (m.index === clone.lastIndex) clone.lastIndex++;
  }
  return -1;
}

/** Basename a token (for command-prefix comparison). */
function basename(t: string): string {
  if (!t.includes("/")) return t;
  const slash = t.lastIndexOf("/");
  return slash >= 0 && slash < t.length - 1 ? t.slice(slash + 1) : t;
}

/**
 * Split the raw command line on unquoted command-boundary operators
 * (`;`, `&&`, `||`, `|`, `&`, newline). Preserves quoting context so
 * operators inside `"..."` or `'...'` do NOT split.
 */
function splitSegments(cmdLine: string): readonly string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  const len = cmdLine.length;
  for (let i = 0; i < len; i++) {
    const c = cmdLine[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < len) {
        buf += c + (cmdLine[i + 1] ?? "");
        i++;
        continue;
      }
      buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "\\" && i + 1 < len) {
      buf += c + (cmdLine[i + 1] ?? "");
      i++;
      continue;
    }
    // Operator detection: `;`, `|` (optionally `||`), `&` (optionally
    // `&&`), `\n`.
    if (c === ";" || c === "\n") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      continue;
    }
    if (c === "|") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      // Skip the second `|` if this is `||`.
      if (cmdLine[i + 1] === "|") i++;
      continue;
    }
    if (c === "&") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      if (cmdLine[i + 1] === "&") i++;
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) segments.push(buf);
  return segments;
}

/**
 * Extract the set of "command-position" base names across every
 * segment of the input. Prevents `echo "sudo"` from matching the
 * `sudo` pattern: the word appears inside a quoted arg, not in a
 * command-head position.
 *
 * Uses `prefix()` to peel wrappers (`env`, `timeout`, `nohup`,
 * `command`, `nice`, `/usr/bin/...`) before taking the head, so
 * `env sudo rm` surfaces `sudo` and `timeout 30 python -c ...`
 * surfaces `python`. Without this, broad `allow: bash:*` rules would
 * silently authorize wrapper-prefixed dangerous commands.
 */
function commandHeads(cmdLine: string): ReadonlySet<string> {
  const heads = new Set<string>();
  for (const seg of splitSegments(cmdLine)) {
    const tokens = shellTokenize(seg);
    if (tokens.length === 0) continue;
    const segPrefix = prefix(tokens);
    if (segPrefix.length === 0) continue;
    // prefix() returns a string like "sudo rm" (wrapper-peeled).
    // Take the first whitespace-separated word and basename it.
    const firstWord = segPrefix.split(/\s+/)[0];
    if (firstWord !== undefined && firstWord.length > 0) {
      heads.add(basename(firstWord).toLowerCase());
    }
  }
  return heads;
}

interface ClassificationSubject {
  readonly raw: string;
  readonly tokens: readonly string[];
  readonly normalizedTokens: readonly string[];
  readonly normalized: string;
  readonly ranges: readonly [number, number][];
  readonly heads: ReadonlySet<string>;
}

const PYTHON_ARG_FLAGS: ReadonlySet<string> = new Set(["-W", "-X", "--check-hash-based-pycs"]);
const NODE_ARG_FLAGS: ReadonlySet<string> = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--input-type",
]);
const PERL_ARG_FLAGS: ReadonlySet<string> = new Set(["-M", "-m"]);
const RUBY_ARG_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-F",
  "-I",
  "-K",
  "-T",
  "-W",
  "-x",
  "-r",
  "--encoding",
  "--external-encoding",
  "--internal-encoding",
]);
const PHP_ARG_FLAGS: ReadonlySet<string> = new Set([
  "-B",
  "-R",
  "-F",
  "-z",
  "-d",
  "-c",
  "-f",
  "--define",
  "--php-ini",
  "--file",
]);
const OSASCRIPT_ARG_FLAGS: ReadonlySet<string> = new Set(["-l", "-s"]);
const SUDO_ARG_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-D",
  "-R",
  "-T",
  "-U",
  "-g",
  "-h",
  "-p",
  "-r",
  "-t",
  "-u",
  "--askpass",
  "--chdir",
  "--chroot",
  "--close-from",
  "--group",
  "--host",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const SUDO_BOOL_FLAGS: ReadonlySet<string> = new Set([
  "-A",
  "-B",
  "-E",
  "-H",
  "-K",
  "-P",
  "-S",
  "-V",
  "-b",
  "-e",
  "-k",
  "-l",
  "-n",
  "-s",
  "-v",
  "--background",
  "--edit",
  "--list",
  "--non-interactive",
  "--preserve-env",
  "--remove-timestamp",
  "--reset-timestamp",
  "--shell",
  "--stdin",
  "--validate",
  "--version",
]);

function buildSubjects(cmdLine: string): readonly ClassificationSubject[] {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return [];

  const nestedShellCommand = extractNestedShellCommand(trimmed);
  const pending = [trimmed];
  if (nestedShellCommand !== null) {
    const inner = nestedShellCommand.trim();
    if (inner.length > 0) pending.push(inner);
  }
  const visited = new Set<string>();
  const subjects: ClassificationSubject[] = [];

  while (pending.length > 0) {
    const raw = pending.shift() ?? "";
    if (raw.length === 0 || visited.has(raw)) continue;
    visited.add(raw);
    const tokens = shellTokenize(raw);
    const normalizedTokens = normalizeTokens(tokens);
    subjects.push({
      raw,
      tokens,
      normalizedTokens,
      normalized: normalizedTokens.join(" "),
      ranges: quoteRanges(raw),
      heads: commandHeads(raw),
    } satisfies ClassificationSubject);

    const strippedSudoTokens = stripLeadingSudo(normalizedTokens);
    if (strippedSudoTokens !== null && strippedSudoTokens.length > 0) {
      pending.push(strippedSudoTokens.join(" "));
    }
  }

  return subjects;
}

function matchesAnyCommandHead(
  commandPrefixes: readonly string[],
  heads: ReadonlySet<string>,
): boolean {
  for (const name of commandPrefixes) {
    const loweredName = name.toLowerCase();
    for (const head of heads) {
      if (head === loweredName || head.startsWith(`${loweredName}.`)) {
        return true;
      }
    }
  }
  return false;
}

function matchesLeadingFlag(
  tokens: readonly string[],
  flagMatch: (token: string) => boolean,
  argFlags: ReadonlySet<string>,
): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (flagMatch(token)) return true;
    if (!token.startsWith("-")) return false;
    if (token.startsWith("--") && token.includes("=")) {
      const name = token.slice(0, token.indexOf("="));
      if (flagMatch(name)) return true;
      if (argFlags.has(name)) continue;
    }
    if (argFlags.has(token)) {
      i++;
      continue;
    }
  }
  return false;
}

function hasNonOptionTail(tokens: readonly string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "--") return i + 1 < tokens.length;
    if (!token.startsWith("-")) return true;
  }
  return false;
}

function matchesLeadingSequence(tokens: readonly string[], expected: readonly string[]): boolean {
  if (tokens.length < expected.length) return false;
  for (const [index, segment] of expected.entries()) {
    if ((tokens[index] ?? "").toLowerCase() !== segment) return false;
  }
  return true;
}

function stripLeadingSudo(tokens: readonly string[]): readonly string[] | null {
  const head = tokens[0]?.toLowerCase();
  if (head !== "sudo") return null;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (token === "--") return tokens.slice(i + 1);
    if (!token.startsWith("-")) return tokens.slice(i);
    if (token.startsWith("--") && token.includes("=")) {
      const name = token.slice(0, token.indexOf("="));
      if (SUDO_ARG_FLAGS.has(name) || SUDO_BOOL_FLAGS.has(name)) {
        i++;
        continue;
      }
      return null;
    }
    if (SUDO_ARG_FLAGS.has(token)) {
      i += 2;
      continue;
    }
    if (SUDO_BOOL_FLAGS.has(token)) {
      i++;
      continue;
    }
    return null;
  }

  return null;
}

function matchesCommandScopedPattern(
  pattern: DangerousPattern,
  subject: ClassificationSubject,
): boolean {
  switch (pattern.id) {
    case "shell-dash-c":
      return extractShellDashCArgFromTokens(subject.normalizedTokens) !== null;
    case "python-dash-c":
      return matchesLeadingFlag(
        subject.normalizedTokens,
        (token) => /^-[a-zA-Z]*c$/.test(token),
        PYTHON_ARG_FLAGS,
      );
    case "node-dash-e":
      return matchesLeadingFlag(
        subject.normalizedTokens,
        (token) => token === "-e" || token === "--eval" || token === "--print" || token === "-p",
        NODE_ARG_FLAGS,
      );
    case "perl-e":
      return matchesLeadingFlag(
        subject.normalizedTokens,
        (token) => /^-[a-zA-Z]*[eE]$/.test(token),
        PERL_ARG_FLAGS,
      );
    case "ruby-e":
      return matchesLeadingFlag(
        subject.normalizedTokens,
        (token) => /^-[a-zA-Z]*[eE]$/.test(token),
        RUBY_ARG_FLAGS,
      );
    case "php-r":
      return matchesLeadingFlag(
        subject.normalizedTokens,
        (token) => token === "-r" || token === "--run",
        PHP_ARG_FLAGS,
      );
    case "osascript-e":
      return matchesLeadingFlag(subject.normalizedTokens, (token) => token === "-e", OSASCRIPT_ARG_FLAGS);
    case "tsx-script":
      return (subject.normalizedTokens[0] ?? "").toLowerCase() === "tsx" && hasNonOptionTail(subject.normalizedTokens);
    case "npx-runner":
      return (subject.normalizedTokens[0] ?? "").toLowerCase() === "npx" && hasNonOptionTail(subject.normalizedTokens);
    case "bunx-runner":
      return (subject.normalizedTokens[0] ?? "").toLowerCase() === "bunx" && hasNonOptionTail(subject.normalizedTokens);
    case "ssh-remote-shell":
      return (subject.normalizedTokens[0] ?? "").toLowerCase() === "ssh" && hasNonOptionTail(subject.normalizedTokens);
    case "gh-api":
      return matchesLeadingSequence(subject.normalizedTokens, ["gh", "api"]);
    case "kubectl-exec":
      return (subject.normalizedTokens[0] ?? "").toLowerCase() === "kubectl"
        && subject.normalizedTokens.some((token, index) => index > 0 && token.toLowerCase() === "exec");
    case "aws-ssm-start-session":
      return matchesLeadingSequence(subject.normalizedTokens, ["aws", "ssm", "start-session"]);
    default:
      return pattern.regex.test(subject.raw) || pattern.regex.test(subject.normalized);
  }
}

export function classifyCommand(cmdLine: string): ClassifyResult {
  const tokens = tokenize(cmdLine);
  const cmdPrefix = prefix(tokens);
  const subjects = buildSubjects(cmdLine);
  const matched: DangerousPattern[] = [];
  const seen = new Set<string>();
  for (const p of DANGEROUS_PATTERNS) {
    if (seen.has(p.id)) continue;
    for (const subject of subjects) {
      if (p.commandPrefixes !== undefined) {
        if (!matchesAnyCommandHead(p.commandPrefixes, subject.heads)) continue;
        // commandPrefixes-scoped patterns test the original subject and
        // the shell-tokenize-normalized form, closing quoted-fragment
        // obfuscation like `py''thon -c`. Some interpreter families need
        // token-position awareness so script argv does not false-positive
        // as inline eval.
        if (matchesCommandScopedPattern(p, subject)) {
          seen.add(p.id);
          matched.push(p);
          break;
        }
      } else {
        // Structural patterns: accept a match only if it lands outside
        // every quoted region (quoted-literal payloads must not
        // false-positive). Adjacent-quote obfuscation (`| s''h`) is
        // caught at the middleware's structural-complexity ratchet
        // via the `!complex` sentinel for any pipeline.
        const rawMatch = firstUnquotedMatch(p.regex, subject.raw, subject.ranges);
        if (rawMatch >= 0) {
          seen.add(p.id);
          matched.push(p);
          break;
        }
      }
    }
  }
  return {
    prefix: cmdPrefix,
    matchedPatterns: matched,
    severity: worstSeverity(matched),
  };
}
