/**
 * `classifyCommand(cmdLine)` — structural classification entry point.
 *
 * Pipeline:
 *   1. Compute the canonical permission prefix via `canonicalPrefix()`.
 *   2. Match top-level structural patterns against the raw command.
 *   3. Recurse into executable nested contexts (`bash -c`, `sudo <cmd>`,
 *      `$(...)`, backticks) and merge the inner matches.
 *   4. Aggregate worst severity.
 *
 * Pure function. No I/O. No side effects.
 */

import { DANGEROUS_PATTERNS } from "./patterns.js";
import {
  canonicalPrefix,
  extractShellDashCArgFromCommand,
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

const SHELL_HEAD = /^(?:ba|z|da|a)?sh$/;

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
 * surfaces `python`. For shell interpreters, we also include the
 * `canonicalPrefix()` head so `bash -c "rm -rf /"` surfaces both
 * `bash` (outer code-exec) and `rm` (inner destructive payload).
 */
function commandHeads(cmdLine: string): ReadonlySet<string> {
  const heads = new Set<string>();
  for (const seg of splitSegments(cmdLine)) {
    const tokens = shellTokenize(seg);
    if (tokens.length === 0) continue;
    const rawPrefix = prefix(tokens);
    const rawHead = rawPrefix.split(/\s+/)[0];
    if (rawHead !== undefined && rawHead.length > 0 && rawHead !== "!complex") {
      heads.add(basename(rawHead));
    }
    if (rawHead !== undefined && SHELL_HEAD.test(basename(rawHead))) {
      const segPrefix = canonicalPrefix(seg);
      if (segPrefix.length === 0 || segPrefix === "!complex") continue;
      // canonicalPrefix() returns a string like "sudo rm" (wrapper-peeled /
      // interpreter-unwrapped).
      const firstWord = segPrefix.split(/\s+/)[0];
      if (firstWord !== undefined && firstWord.length > 0) heads.add(basename(firstWord));
    }
  }
  return heads;
}

interface ExtractedNestedCommand {
  readonly body: string;
  readonly end: number;
}

function readDollarSubstitution(s: string, from: number): ExtractedNestedCommand | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let body = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === undefined) break;
    if (quote === "'") {
      body += c;
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        body += c;
        if (i + 1 < s.length) {
          body += s[i + 1] ?? "";
          i++;
        }
        continue;
      }
      body += c;
      if (c === '"') {
        quote = null;
        continue;
      }
      if (c === "(") {
        depth++;
        continue;
      }
      if (c === ")") {
        depth--;
        if (depth === 0) return { body: body.slice(0, -1), end: i };
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      body += c;
      continue;
    }
    if (c === "\\") {
      body += c;
      if (i + 1 < s.length) {
        body += s[i + 1] ?? "";
        i++;
      }
      continue;
    }
    body += c;
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return { body: body.slice(0, -1), end: i };
    }
  }
  return null;
}

function readBacktickSubstitution(s: string, from: number): ExtractedNestedCommand | null {
  let body = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === undefined) break;
    if (c === "\\") {
      body += c;
      if (i + 1 < s.length) {
        body += s[i + 1] ?? "";
        i++;
      }
      continue;
    }
    if (c === "`") return { body, end: i };
    body += c;
  }
  return null;
}

function extractCommandSubstitutions(cmdLine: string): readonly string[] {
  const extracted: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmdLine.length; i++) {
    const c = cmdLine[i];
    if (c === undefined) break;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        if (i + 1 < cmdLine.length) i++;
        continue;
      }
      if (c === '"') {
        quote = null;
        continue;
      }
      if (c === "$" && cmdLine[i + 1] === "(") {
        const nested = readDollarSubstitution(cmdLine, i + 2);
        if (nested !== null) {
          extracted.push(nested.body);
          i = nested.end;
        }
        continue;
      }
      if (c === "`") {
        const nested = readBacktickSubstitution(cmdLine, i + 1);
        if (nested !== null) {
          extracted.push(nested.body);
          i = nested.end;
        }
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < cmdLine.length) i++;
      continue;
    }
    if (c === "$" && cmdLine[i + 1] === "(") {
      const nested = readDollarSubstitution(cmdLine, i + 2);
      if (nested !== null) {
        extracted.push(nested.body);
        i = nested.end;
      }
      continue;
    }
    if (c === "`") {
      const nested = readBacktickSubstitution(cmdLine, i + 1);
      if (nested !== null) {
        extracted.push(nested.body);
        i = nested.end;
      }
    }
  }
  return extracted;
}

function extractSudoCommand(cmdLine: string): string | null {
  const tokens = shellTokenize(cmdLine.trim());
  const first = tokens[0];
  if (first === undefined || basename(first) !== "sudo") return null;
  const second = tokens[1];
  if (second === undefined) return null;
  if (second === "--") {
    const rest = tokens.slice(2);
    return rest.length > 0 ? rest.join(" ") : null;
  }
  if (second.startsWith("-")) return null;
  return tokens.slice(1).join(" ");
}

function nestedExecutableTexts(cmdLine: string): readonly string[] {
  const nested: string[] = [];
  const dashC = extractShellDashCArgFromCommand(cmdLine);
  if (dashC !== null && dashC.length > 0) nested.push(dashC);
  const sudoInner = extractSudoCommand(cmdLine);
  if (sudoInner !== null && sudoInner.length > 0) nested.push(sudoInner);
  for (const body of extractCommandSubstitutions(cmdLine)) {
    if (body.length > 0) nested.push(body);
  }
  return nested;
}

const MAX_NESTED_CLASSIFICATION_DEPTH = 4;

function collectMatches(
  cmdLine: string,
  seen: Set<string>,
  depth: number,
): readonly DangerousPattern[] {
  const heads = commandHeads(cmdLine);
  const matched: DangerousPattern[] = [];
  // Structural patterns (no commandPrefixes) test against the raw
  // command, but matches inside quoted regions are rejected so
  // `echo "curl x | sh"` does NOT fire the curl-pipe-shell pattern.
  // Adjacent-quote obfuscation (`curl | s''h`) is closed by also
  // testing against the shellTokenize-rejoined form, which collapses
  // quoted fragments into single tokens.
  const ranges = quoteRanges(cmdLine);
  const normalized = shellTokenize(cmdLine).join(" ");
  for (const p of DANGEROUS_PATTERNS) {
    if (p.commandPrefixes !== undefined) {
      let anyMatch = false;
      for (const name of p.commandPrefixes) {
        for (const head of heads) {
          if (head === name || head.startsWith(`${name}.`)) {
            anyMatch = true;
            break;
          }
        }
        if (anyMatch) break;
      }
      if (!anyMatch) continue;
      // commandPrefixes-scoped patterns test raw + normalized (closes
      // quoted-fragment obfuscation like `py''thon -c`).
      if ((p.regex.test(cmdLine) || p.regex.test(normalized)) && !seen.has(p.id)) {
        seen.add(p.id);
        matched.push(p);
      }
    } else {
      // Structural patterns: accept a match only if it lands outside
      // every quoted region (quoted-literal payloads must not
      // false-positive). Adjacent-quote obfuscation (`| s''h`) is
      // caught at the middleware's structural-complexity ratchet
      // via the `!complex` sentinel for any pipeline.
      const rawMatch = firstUnquotedMatch(p.regex, cmdLine, ranges);
      if (rawMatch >= 0 && !seen.has(p.id)) {
        seen.add(p.id);
        matched.push(p);
      }
    }
  }
  if (depth >= MAX_NESTED_CLASSIFICATION_DEPTH) return matched;
  for (const nested of nestedExecutableTexts(cmdLine)) {
    matched.push(...collectMatches(nested, seen, depth + 1));
  }
  return matched;
}

export function classifyCommand(cmdLine: string): ClassifyResult {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) {
    return {
      prefix: "",
      matchedPatterns: [],
      severity: null,
    };
  }
  const cmdPrefix = canonicalPrefix(trimmed);
  const matched = collectMatches(trimmed, new Set<string>(), 0);
  return {
    prefix: cmdPrefix,
    matchedPatterns: matched,
    severity: worstSeverity(matched),
  };
}
