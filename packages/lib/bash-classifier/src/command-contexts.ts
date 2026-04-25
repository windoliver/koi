import {
  extractShellDashCArgFromTokens,
  normalizeForHeadScan,
  shellTokenize,
  skipShellSyntaxTokens,
  UNSAFE_PREFIX,
} from "./prefix.js";

export interface CommandContext {
  readonly raw: string;
  readonly normalized: string;
  readonly heads: ReadonlySet<string>;
}

export interface CollectedCommandContexts {
  readonly contexts: readonly CommandContext[];
  readonly truncated: boolean;
}

// Bound total traversal work by the number of discovered command contexts
// rather than raw nesting depth, so one extra wrapper layer does not make
// the leaf executable disappear from classification.
const MAX_CONTEXTS = 256;

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
  "--chdir",
  "--chroot",
  "--close-from",
  "--command-timeout",
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
  "-i",
  "-k",
  "-l",
  "-n",
  "-s",
  "-v",
  "--askpass",
  "--background",
  "--edit",
  "--help",
  "--list",
  "--non-interactive",
  "--preserve-env",
  "--remove-timestamp",
  "--reset-timestamp",
  "--set-home",
  "--shell",
  "--login",
  "--stdin",
  "--validate",
  "--version",
]);

const SUDO_SHELL_MODE_FLAGS: ReadonlySet<string> = new Set(["-s", "--shell", "-i", "--login"]);

const SUDO_SHORT_ARG_FLAGS: ReadonlySet<string> = new Set(
  Array.from(SUDO_ARG_FLAGS).filter((flag) => flag.length === 2 && flag.startsWith("-")),
);

const SUDO_SHORT_BOOL_FLAGS: ReadonlySet<string> = new Set(
  Array.from(SUDO_BOOL_FLAGS).filter((flag) => flag.length === 2 && flag.startsWith("-")),
);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function basename(token: string): string {
  if (!token.includes("/")) return token;
  const slash = token.lastIndexOf("/");
  return slash >= 0 && slash < token.length - 1 ? token.slice(slash + 1) : token;
}

function stripGroupingPunctuation(token: string): string {
  let current = token;
  while (current.startsWith("(") || current.startsWith("{")) {
    current = current.slice(1);
  }
  while (current.endsWith(")") || current.endsWith("}") || current.endsWith(";")) {
    current = current.slice(0, -1);
  }
  return current;
}

function normalizeVisibleTokens(tokens: readonly string[]): readonly string[] {
  const normalized = normalizeForHeadScan(tokens);
  const first = normalized[0];
  if (first === undefined || first === UNSAFE_PREFIX) return [];
  return normalized;
}

function stripShellSyntaxPrefixes(tokens: readonly string[]): readonly string[] {
  return tokens.slice(skipShellSyntaxTokens(tokens, 0));
}

function normalizeExecutionView(tokens: readonly string[]): readonly string[] {
  let current = tokens;
  const max = tokens.length + 2;
  for (let i = 0; i < max; i++) {
    const next = stripShellSyntaxPrefixes(
      normalizeVisibleTokens(stripShellSyntaxPrefixes(current)),
    );
    if (next.length === current.length && next.every((token, idx) => token === current[idx])) {
      return next;
    }
    current = next;
  }
  return current;
}

function consumeClusteredSudoShortFlags(
  tokens: readonly string[],
  token: string,
  index: number,
): { readonly nextIndex: number; readonly shellMode: boolean } | null {
  if (token.startsWith("--") || token.length <= 2) return null;

  const cluster = token.slice(1);
  let shellMode = false;
  for (let i = 0; i < cluster.length; i++) {
    const flag = `-${cluster[i]}`;
    if (SUDO_SHORT_BOOL_FLAGS.has(flag)) {
      if (SUDO_SHELL_MODE_FLAGS.has(flag)) shellMode = true;
      continue;
    }
    if (SUDO_SHORT_ARG_FLAGS.has(flag)) {
      // `-Eu alice` => `-u` consumes the next token.
      // `-uroot` / `-EHuroot` => the remainder of this token is the arg.
      return {
        nextIndex:
          i === cluster.length - 1 ? skipShellSyntaxTokens(tokens, index + 1) + 1 : index + 1,
        shellMode,
      };
    }
    return null;
  }

  return { nextIndex: index + 1, shellMode };
}

function peelSudoTokens(tokens: readonly string[]): readonly string[] | null {
  const normalized = normalizeExecutionView(tokens);
  const first = normalized[0];
  if (first === undefined || basename(first) !== "sudo") return null;

  // let: cursor advances through sudo's option grammar.
  let i = 1;
  let shellMode = false;
  while (i < normalized.length) {
    i = skipShellSyntaxTokens(normalized, i);
    const token = normalized[i] ?? "";
    if (token === "--") {
      const remaining = normalized.slice(i + 1);
      return shellMode ? shellTokenize(remaining.join(" ")) : remaining;
    }
    if (!token.startsWith("-") || token === "-") {
      const remaining = normalized.slice(i);
      return shellMode ? shellTokenize(remaining.join(" ")) : remaining;
    }

    if (token.startsWith("--") && token.includes("=")) {
      const name = token.slice(0, token.indexOf("="));
      if (SUDO_ARG_FLAGS.has(name) || SUDO_BOOL_FLAGS.has(name)) {
        if (SUDO_SHELL_MODE_FLAGS.has(name)) shellMode = true;
        i++;
        continue;
      }
      return null;
    }

    if (SUDO_ARG_FLAGS.has(token)) {
      i = skipShellSyntaxTokens(normalized, i + 1) + 1;
      continue;
    }

    if (SUDO_BOOL_FLAGS.has(token)) {
      if (SUDO_SHELL_MODE_FLAGS.has(token)) shellMode = true;
      i++;
      continue;
    }

    const clustered = consumeClusteredSudoShortFlags(normalized, token, i);
    if (clustered !== null) {
      if (clustered.shellMode) shellMode = true;
      i = clustered.nextIndex;
      continue;
    }

    return null;
  }

  return [];
}

function extractSudoShellScripts(tokens: readonly string[]): readonly string[] {
  const normalized = normalizeExecutionView(tokens);
  const first = normalized[0];
  if (first === undefined || basename(first) !== "sudo") return [];

  const scripts: string[] = [];
  let i = 1;
  let shellMode = false;
  while (i < normalized.length) {
    i = skipShellSyntaxTokens(normalized, i);
    const token = normalized[i] ?? "";
    if (token === "--") {
      if (shellMode) {
        const start = skipShellSyntaxTokens(normalized, i + 1);
        const script = normalized.slice(start).join(" ");
        if (script.length > 0) scripts.push(script);
      }
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      if (shellMode) {
        const script = normalized.slice(i).join(" ");
        if (script.length > 0) scripts.push(script);
      }
      break;
    }

    if (token.startsWith("--") && token.includes("=")) {
      const name = token.slice(0, token.indexOf("="));
      if (SUDO_ARG_FLAGS.has(name) || SUDO_BOOL_FLAGS.has(name)) {
        if (SUDO_SHELL_MODE_FLAGS.has(name)) shellMode = true;
        i++;
        continue;
      }
      break;
    }

    if (SUDO_ARG_FLAGS.has(token)) {
      i = skipShellSyntaxTokens(normalized, i + 1) + 1;
      continue;
    }

    if (SUDO_BOOL_FLAGS.has(token)) {
      if (SUDO_SHELL_MODE_FLAGS.has(token)) shellMode = true;
      i++;
      continue;
    }

    const clustered = consumeClusteredSudoShortFlags(normalized, token, i);
    if (clustered !== null) {
      if (clustered.shellMode) shellMode = true;
      i = clustered.nextIndex;
      continue;
    }

    break;
  }
  return scripts;
}

function executionChains(tokens: readonly string[]): readonly (readonly string[])[] {
  const chains: (readonly string[])[] = [];
  let current = normalizeExecutionView(tokens);
  const max = current.length + 1;
  for (let depth = 0; depth < max && current.length > 0; depth++) {
    chains.push(current);
    const head = current[0];
    if (head === undefined || basename(head) !== "sudo") break;
    const inner = peelSudoTokens(current);
    if (inner === null || inner.length === 0) break;
    current = normalizeExecutionView(inner);
  }
  return chains;
}

function collectHeads(tokens: readonly string[]): ReadonlySet<string> {
  const heads = new Set<string>();
  for (const chain of executionChains(tokens)) {
    for (const token of chain) {
      const head = stripGroupingPunctuation(token);
      if (head.length === 0) continue;
      heads.add(basename(head));
      break;
    }
  }
  return heads;
}

interface ExtractedCommand {
  readonly body: string;
  readonly end: number;
}

function readBacktickCommand(s: string, start: number): ExtractedCommand | null {
  let body = "";
  // let: cursor scans for the matching unescaped backtick.
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === undefined) break;
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined) break;
      // Inside a backtick body, escaped backticks delimit nested legacy
      // command substitution. Unescape them so the recursive scanner that
      // later walks `body` can see the inner command.
      body += next === "`" ? "`" : `${c}${next}`;
      i += 2;
      continue;
    }
    if (c === "`") {
      return { body, end: i };
    }
    body += c;
    i++;
  }
  return null;
}

function readParenCommand(s: string, start: number): ExtractedCommand | null {
  const opener = s[start];
  if (opener === "$" && s[start + 2] === "(") {
    return null;
  }

  const trackPlainGrouping = opener === "$";
  let quote: "'" | '"' | null = null;
  // let: depth tracks nested command substitutions/process substitutions.
  let depth = 1;
  // let: cursor scans until the matching closing parenthesis.
  let i = start + 2;
  while (i < s.length) {
    const c = s[i];
    if (c === undefined) break;

    if (quote === "'") {
      if (c === "'") quote = null;
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"') {
        quote = null;
        i++;
        continue;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "$" && s[i + 1] === "(") {
        if (s[i + 2] !== "(") {
          const extracted = readParenCommand(s, i);
          if (extracted !== null) {
            i = extracted.end + 1;
            continue;
          }
        }
      }
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }

    if (c === "\\") {
      i += 2;
      continue;
    }

    if ((c === "$" || c === "<" || c === ">") && s[i + 1] === "(") {
      if (!(c === "$" && s[i + 2] === "(")) depth++;
      i += 2;
      continue;
    }

    if (trackPlainGrouping && c === "(") {
      depth++;
      i++;
      continue;
    }

    if (c === ")") {
      depth--;
      if (depth === 0) {
        return { body: s.slice(start + 2, i), end: i };
      }
    }

    i++;
  }

  return null;
}

function extractNestedCommandStrings(s: string): readonly string[] {
  const nested: string[] = [];
  let quote: "'" | '"' | null = null;
  // let: cursor walks the raw shell string and extracts executable subcommands.
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === undefined) break;

    if (quote === "'") {
      if (c === "'") quote = null;
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"') {
        quote = null;
        i++;
        continue;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        const extracted = readBacktickCommand(s, i);
        if (extracted !== null) {
          if (extracted.body.trim().length > 0) nested.push(extracted.body);
          i = extracted.end + 1;
          continue;
        }
      }
      if (c === "$" && s[i + 1] === "(") {
        const extracted = readParenCommand(s, i);
        if (extracted !== null) {
          if (extracted.body.trim().length > 0) nested.push(extracted.body);
          i = extracted.end + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }

    if (c === "\\") {
      i += 2;
      continue;
    }

    if (c === "`") {
      const extracted = readBacktickCommand(s, i);
      if (extracted !== null) {
        if (extracted.body.trim().length > 0) nested.push(extracted.body);
        i = extracted.end + 1;
        continue;
      }
    }

    if ((c === "$" || c === "<" || c === ">") && s[i + 1] === "(") {
      const extracted = readParenCommand(s, i);
      if (extracted !== null) {
        if (extracted.body.trim().length > 0) nested.push(extracted.body);
        i = extracted.end + 1;
        continue;
      }
    }

    i++;
  }
  return nested;
}

function extractEnvDashSScripts(tokens: readonly string[]): readonly string[] {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i] ?? "")) i++;

  const first = tokens[i];
  if (first === undefined || basename(first) !== "env") return [];

  const scripts: string[] = [];
  const collectTrailingOperands = (from: number): string => {
    const parts: string[] = [];
    let cursor = from;
    while (cursor < tokens.length) {
      cursor = skipShellSyntaxTokens(tokens, cursor);
      const part = tokens[cursor];
      if (part === undefined) break;
      parts.push(part);
      cursor++;
    }
    return parts.join(" ");
  };
  i++;
  while (i < tokens.length) {
    i = skipShellSyntaxTokens(tokens, i);
    const token = tokens[i] ?? "";
    if (token === "--") break;
    if (token === "-S" || token === "--split-string") {
      const script = tokens[skipShellSyntaxTokens(tokens, i + 1)];
      if (script !== undefined && script.length > 0) {
        const trailing = collectTrailingOperands(skipShellSyntaxTokens(tokens, i + 1) + 1);
        scripts.push(trailing.length > 0 ? `${script} ${trailing}` : script);
      }
      break;
    }
    if (token.startsWith("-S") && token.length > 2) {
      const script = token.slice(2);
      if (script.length > 0) {
        const trailing = collectTrailingOperands(i + 1);
        scripts.push(trailing.length > 0 ? `${script} ${trailing}` : script);
      }
      break;
    }
    if (token.startsWith("--split-string=")) {
      const script = token.slice(token.indexOf("=") + 1);
      if (script.length > 0) {
        const trailing = collectTrailingOperands(i + 1);
        scripts.push(trailing.length > 0 ? `${script} ${trailing}` : script);
      }
      break;
    }
    if (!token.startsWith("-")) break;
    if (token.length > 1 && !token.startsWith("--") && token.includes("S")) {
      const script = tokens[skipShellSyntaxTokens(tokens, i + 1)];
      if (script !== undefined && script.length > 0) scripts.push(script);
      break;
    }
    if (
      token === "-u" ||
      token === "--unset" ||
      token === "-C" ||
      token === "--chdir" ||
      token === "-P" ||
      token === "--path"
    ) {
      i = skipShellSyntaxTokens(tokens, i + 1) + 1;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      i++;
      continue;
    }
    i++;
  }
  return scripts;
}

function extractShellInnerScripts(tokens: readonly string[]): readonly string[] {
  const nested = [...extractEnvDashSScripts(tokens)];
  for (const chain of executionChains(tokens)) {
    const inner = extractShellDashCArgFromTokens(chain);
    if (inner !== null && inner.trim().length > 0) nested.push(inner);
    nested.push(...extractEnvDashSScripts(chain));
    nested.push(...extractSudoShellScripts(chain));
  }
  return nested;
}

function splitSegments(cmdLine: string): readonly string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  // let: cursor walks the raw string and cuts only on unquoted command operators.
  let i = 0;
  while (i < cmdLine.length) {
    const c = cmdLine[i];
    if (c === undefined) break;

    if (quote === "'") {
      if (c === "'") quote = null;
      buf += c;
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"') quote = null;
      if (c === "\\" && i + 1 < cmdLine.length) {
        buf += c + (cmdLine[i + 1] ?? "");
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      i++;
      continue;
    }

    if (c === "\\" && i + 1 < cmdLine.length) {
      buf += c + (cmdLine[i + 1] ?? "");
      i += 2;
      continue;
    }

    if (c === ";" || c === "\n") {
      if (buf.trim().length > 0) segments.push(buf.trim());
      buf = "";
      i++;
      continue;
    }

    if (c === "|") {
      if (buf.trim().length > 0) segments.push(buf.trim());
      buf = "";
      i += cmdLine[i + 1] === "|" ? 2 : 1;
      continue;
    }

    if (c === "&") {
      if (buf.trim().length > 0) segments.push(buf.trim());
      buf = "";
      i += cmdLine[i + 1] === "&" ? 2 : 1;
      continue;
    }

    buf += c;
    i++;
  }

  if (buf.trim().length > 0) segments.push(buf.trim());
  return segments;
}

function wrapsWholeParenGroup(cmdLine: string): boolean {
  if (!cmdLine.startsWith("(") || !cmdLine.endsWith(")")) return false;

  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = 0; i < cmdLine.length; i++) {
    const c = cmdLine[i];
    if (c === undefined) break;

    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < cmdLine.length) i++;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }

    if (c === "\\" && i + 1 < cmdLine.length) {
      i++;
      continue;
    }

    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && i < cmdLine.length - 1) return false;
  }

  return depth === 0;
}

function unwrapWholeGroup(cmdLine: string): string | null {
  if (wrapsWholeParenGroup(cmdLine)) {
    return cmdLine.slice(1, -1).trim();
  }

  if (
    cmdLine.startsWith("{") &&
    cmdLine.endsWith("}") &&
    (cmdLine[1] === " " || cmdLine[1] === "\t" || cmdLine[1] === "\n")
  ) {
    const inner = cmdLine.slice(1, -1).trim();
    return inner.replace(/;\s*$/, "").trim();
  }

  return null;
}

export function collectCommandContexts(cmdLine: string): CollectedCommandContexts {
  const contexts: CommandContext[] = [];
  const seen = new Set<string>();
  const pending = [cmdLine];

  while (pending.length > 0 && contexts.length < MAX_CONTEXTS) {
    const current = pending.pop();
    if (current === undefined) break;

    const trimmed = current.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);

    const tokens = shellTokenize(trimmed);
    contexts.push({
      raw: trimmed,
      normalized: tokens.join(" "),
      heads: collectHeads(tokens),
    });

    const unwrapped = unwrapWholeGroup(trimmed);
    if (unwrapped !== null) pending.push(unwrapped);

    const segments = splitSegments(trimmed);
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      if (segment !== undefined && segment !== trimmed) pending.push(segment);
    }

    const nested = [...extractShellInnerScripts(tokens), ...extractNestedCommandStrings(trimmed)];
    for (let i = nested.length - 1; i >= 0; i--) {
      const inner = nested[i];
      if (inner !== undefined) pending.push(inner);
    }
  }

  return {
    contexts,
    truncated: pending.length > 0,
  };
}

export function hasShellDashCInvocation(cmdLine: string): boolean {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return false;
  const tokens = shellTokenize(trimmed);
  return extractShellInnerScripts(tokens).length > 0;
}
