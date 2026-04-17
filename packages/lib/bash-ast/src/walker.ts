/**
 * @koi/bash-ast — allowlist-based AST walker.
 *
 * Walks a tree-sitter-bash parse tree and extracts a `SimpleCommand[]` from
 * each simple command in the source. ANY node type not explicitly handled
 * here causes the walker to return `too-complex`. This is the fail-closed
 * invariant: unknown grammar never produces an argv.
 *
 * The walker is a pure function over the parse tree. It does not own the
 * parser or the source string; callers (classify.ts) handle those.
 *
 * Phase-1 scope (per decision 8A / 4A in the design review):
 *   - No variable scope tracking. Any $VAR / ${VAR} / $(...) → too-complex.
 *   - No per-command semantic specs. argv is the output; higher layers
 *     decide what each command means.
 *   - No wrapper-command unwrapping (nohup, timeout, sudo, …).
 *   - No heredoc bodies.
 *   - No concatenation (adjacent tokens forming one argv element).
 */

import type { Node } from "web-tree-sitter";
import type { Redirect, SimpleCommand, TooComplexCategory } from "./types.js";

/** Walker result — flat discriminated union. `ok` carries an empty list for
 * programs with no commands (whitespace, comments, lone separators). */
type WalkResult =
  | { readonly kind: "ok"; readonly commands: readonly SimpleCommand[] }
  | {
      readonly kind: "too-complex";
      readonly reason: string;
      readonly nodeType?: string;
      readonly primaryCategory: TooComplexCategory;
    };

/** Operator tokens that separate commands at the container level. These are
 * leaf nodes with no payload; walking them is a no-op. */
const SEPARATOR_NODE_TYPES: ReadonlySet<string> = new Set([
  ";",
  ";;",
  "&&",
  "||",
  "|",
  "&",
  "|&",
  "\n",
  "",
]);

/**
 * Match a bash special-parameter reference at the start of a
 * `simple_expansion` text. The regex recognizes:
 *
 *   - `$0`..`$9`                   — positional parameters (single digit;
 *                                     `$10` expands as `$1` + literal `0`).
 *   - `$@`, `$*`, `$#`, `$?`, `$!`  — well-known special parameters.
 *   - `$$`, `$-`                   — shell-state special parameters.
 *   - `$_`                         — only when NOT followed by an identifier
 *                                     continuation character. Bash treats
 *                                     `$_x` as variable reference `_x`
 *                                     (underscore is a valid identifier
 *                                     start), so `$_x` must stay
 *                                     scope-trackable. Bare `$_` or `$_`
 *                                     followed by punctuation is the
 *                                     special parameter.
 *
 * Mixed-literal concatenation (`$1suffix`, `$0done`) still matches — tree-
 * sitter-bash emits the whole merged token as one `simple_expansion` text.
 *
 * SECURITY: do not relax this rule without re-reviewing the Round 3
 * adversarial finding. Treating `$_x` as a special parameter would mask a
 * real scope-trackable variable reference.
 */
const SPECIAL_PARAMETER_RE = /^\$(?:[0-9]|[@*#?!$-]|_(?![A-Za-z0-9_]))/;

function isSpecialParameter(text: string): boolean {
  return SPECIAL_PARAMETER_RE.test(text);
}

/**
 * Match a `simple_expansion` text shape that bash would actually treat as
 * an expansion. The pattern is `$` followed by either a valid bash
 * identifier start (`[A-Za-z_]`) or a one-character special parameter
 * (`[0-9@*#?!$-]`).
 *
 * Tree-sitter-bash occasionally emits `simple_expansion` for shapes bash
 * resolves literally — e.g. inside `"foo$ bar"` the grammar produces a
 * `simple_expansion "$ bar"` whose child `variable_name` text is `" bar"`.
 * bash treats the `$` as a literal dollar sign (because a space cannot
 * start an identifier) so the argv stays static. Use this check to
 * distinguish real expansions (which the walker rejects) from parse-
 * quirk literals (which it should pass through as literal text).
 */
const REAL_EXPANSION_RE = /^\$(?:[A-Za-z_]|[0-9@*#?!$-])/;

function isRealExpansion(text: string): boolean {
  return REAL_EXPANSION_RE.test(text);
}

/** Valid file-redirect operator tokens. */
const REDIRECT_OP_TYPES: ReadonlySet<string> = new Set([
  ">",
  ">>",
  "<",
  "<<<",
  ">&",
  "<&",
  "&>",
  "&>>",
  ">|",
]);

/** Entry point: walk a `program` root node and return all simple commands. */
export function walkProgram(root: Node): WalkResult {
  if (root.hasError) {
    return tooComplex("tree-sitter parse error in source", "ERROR", "parse-error");
  }
  return walkContainer(root);
}

/** Walk a structural container (`program`, `list`, `pipeline`). Children are
 * either commands, nested containers, or separator tokens. */
function walkContainer(node: Node): WalkResult {
  const commands: SimpleCommand[] = [];
  for (const child of node.children) {
    if (SEPARATOR_NODE_TYPES.has(child.type)) continue;
    const result = walkStatement(child);
    if (result.kind === "too-complex") return result;
    commands.push(...result.commands);
  }
  return { kind: "ok", commands };
}

/** Walk a single statement node. Dispatches based on node type. */
function walkStatement(node: Node): WalkResult {
  switch (node.type) {
    case "program":
    case "list":
    case "pipeline":
      return walkContainer(node);
    case "redirected_statement":
      return walkRedirectedStatement(node);
    case "command":
      return walkCommand(node, []);
    case "comment":
      return { kind: "ok", commands: [] };
    case "for_statement":
    case "while_statement":
    case "if_statement":
    case "case_statement":
    case "function_definition":
    case "subshell":
      return tooComplex(
        `control-flow statement (${node.type}) is not supported`,
        node.type,
        "control-flow",
      );
    case "variable_assignment":
    case "variable_assignments":
      return tooComplex(`top-level ${node.type} is not supported`, node.type, "unsupported-syntax");
    case "declaration_command":
      return tooComplex(
        "declaration_command (export/declare/local/readonly/typeset) is not supported",
        node.type,
        "unsupported-syntax",
      );
    default:
      return tooComplex(`unsupported statement: ${node.type}`, node.type, "unknown");
  }
}

/** Walk a `redirected_statement`. Extracts the inner command and its redirects. */
function walkRedirectedStatement(node: Node): WalkResult {
  let command: Node | null = null;
  const redirects: Redirect[] = [];

  for (const child of node.children) {
    if (SEPARATOR_NODE_TYPES.has(child.type)) continue;
    if (child.type === "command") {
      if (command !== null) {
        // Walker assertion: `redirected_statement` wraps exactly one
        // `command` child. Multiple command children has no known
        // reachability under the vendored grammar for valid bash input.
        // Route to `malformed` so the fail-closed branch in `dispose()`
        // hard-denies rather than letting it fall through to askable.
        return tooComplex("multiple commands in redirected_statement", child.type, "malformed");
      }
      command = child;
      continue;
    }
    if (child.type === "file_redirect") {
      const r = walkFileRedirect(child);
      if (r.kind === "too-complex") return r;
      redirects.push(r.redirect);
      continue;
    }
    if (child.type === "heredoc_redirect") {
      return tooComplex("heredoc redirects are not supported", "heredoc_redirect", "heredoc");
    }
    // Structural assertion: redirected_statement should contain
    // exactly one command child plus redirect nodes. Any other child
    // type (e.g. `variable_assignments` in the rare multi-env
    // redirect case) means the walker's mental model doesn't match
    // the AST. Fail closed via `malformed` rather than hand a tree
    // shape the walker didn't understand to regex/elicit fallback.
    return tooComplex(
      `unexpected child in redirected_statement: ${child.type}`,
      child.type,
      "malformed",
    );
  }

  if (command === null) {
    // Redirect-only shapes like `> out.txt`, `2>&1`, or `>>out.txt`
    // reach here. The walker cannot produce a static argv for a
    // statement with no command, and permission rules keyed off argv
    // cannot meaningfully evaluate it. Fail closed via `malformed`
    // rather than let it fall through to regex/elicit where a user
    // could approve execution of a structure the walker didn't
    // actually model.
    return tooComplex(
      "redirected_statement with no inner command",
      "redirected_statement",
      "malformed",
    );
  }
  return walkCommand(command, redirects);
}

/** Walk a `command` node. Collects env vars, argv, and attaches pre-extracted
 * redirects (from an enclosing `redirected_statement`, if any). */
function walkCommand(node: Node, redirects: readonly Redirect[]): WalkResult {
  const argv: string[] = [];
  const envVars: { name: string; value: string }[] = [];
  let sawCommandName = false;

  // SECURITY pre-scan: detect the locale-translated-string split form.
  // Tree-sitter-bash parses `$"..."` in argument position as two sibling
  // children — a bare `$` followed by a `string` — with NO whitespace
  // between them (the `$` and the opening `"` are byte-adjacent in the
  // source). The effective argv for that pair depends on the shell's
  // locale/translation catalog and may diverge from the raw source, so
  // fail closed via shell-escape when the adjacency holds.
  //
  // Lexical adjacency MUST be checked via byte offsets. Sibling order
  // alone is not sufficient: `echo $ "msg"` has whitespace between `$`
  // and `"msg"`, which is two separate argv elements (literal `$` then
  // quoted string `msg`), not locale translation. Using node.endIndex
  // vs node.startIndex correctly distinguishes the two shapes.
  for (let i = 0; i < node.children.length; i += 1) {
    const current = node.children[i];
    if (current === undefined || current.type !== "$") continue;
    const next = node.children[i + 1];
    if (next !== undefined && next.type === "string" && current.endIndex === next.startIndex) {
      return tooComplex('locale-translated string ($"...") is not supported', "$", "shell-escape");
    }
  }

  for (const child of node.children) {
    if (SEPARATOR_NODE_TYPES.has(child.type)) continue;
    if (child.type === "variable_assignment") {
      if (sawCommandName) {
        return tooComplex("variable assignment after command name", child.type, "malformed");
      }
      const ev = walkVariableAssignment(child);
      if (ev.kind === "too-complex") return ev;
      envVars.push(ev.value);
      continue;
    }
    if (child.type === "command_name") {
      const inner = child.children[0];
      if (inner === undefined) {
        return tooComplex("empty command_name", "command_name", "malformed");
      }
      const v = walkArgNode(inner);
      if (v.kind === "too-complex") return v;
      argv.push(v.value);
      sawCommandName = true;
      continue;
    }
    // Post-command-name argument
    const v = walkArgNode(child);
    if (v.kind === "too-complex") return v;
    argv.push(v.value);
  }

  if (argv.length === 0) {
    // A command node with only env-var assignments (e.g. `FOO=bar BAZ=qux`)
    // and no actual command to execute. Envs alone can set e.g. LD_PRELOAD
    // which is security-relevant, so bail out rather than silently drop.
    if (envVars.length > 0) {
      return tooComplex(
        "assignment-only command without an executable",
        "variable_assignment",
        "malformed",
      );
    }
    return { kind: "ok", commands: [] };
  }

  return {
    kind: "ok",
    commands: [{ argv, envVars, redirects, text: node.text }],
  };
}

/** Walk a `variable_assignment` node. Children: `variable_name`, `=`, value. */
function walkVariableAssignment(node: Node):
  | { kind: "ok"; value: { name: string; value: string } }
  | {
      kind: "too-complex";
      reason: string;
      nodeType?: string;
      primaryCategory: TooComplexCategory;
    } {
  let name: string | null = null;
  let valueNode: Node | null = null;
  let sawEquals = false;

  for (const child of node.children) {
    if (child.type === "variable_name") {
      name = child.text;
      continue;
    }
    if (child.type === "=") {
      sawEquals = true;
      continue;
    }
    if (sawEquals) {
      if (valueNode !== null) {
        return tooComplex("multiple values in variable_assignment", child.type, "malformed");
      }
      valueNode = child;
      continue;
    }
    // Any child before `=` that is not `variable_name` or `=` is an
    // unexpected AST shape under the current grammar. Fail closed via
    // `malformed` — silently ignoring these could let a drifted tree
    // produce a trusted env assignment the walker did not actually
    // validate.
    return tooComplex(
      `unexpected child in variable_assignment before =: ${child.type}`,
      child.type,
      "malformed",
    );
  }

  if (name === null) {
    return tooComplex("variable_assignment without a name", "variable_assignment", "malformed");
  }
  if (valueNode === null) {
    // `FOO=` — empty value is allowed, treat as empty string
    return { kind: "ok", value: { name, value: "" } };
  }
  const v = walkArgNode(valueNode);
  if (v.kind === "too-complex") return v;
  return { kind: "ok", value: { name, value: v.value } };
}

/** Walk an argument-position node. Resolves to a static string or too-complex. */
function walkArgNode(node: Node):
  | { kind: "ok"; value: string }
  | {
      kind: "too-complex";
      reason: string;
      nodeType?: string;
      primaryCategory: TooComplexCategory;
    } {
  switch (node.type) {
    case "word":
      // SECURITY: reject any word containing a backslash. Tree-sitter
      // preserves raw source; bash strips `\x` in unquoted context (e.g.
      // `\/etc\/passwd` runs `/etc/passwd`). Returning `node.text` here
      // would lie about the effective argv: a permission rule matching on
      // argv would see backslashes the attacker's command never runs with.
      // Force too-complex → transitional regex fallback rather than
      // emulate bash's escape semantics.
      if (node.text.includes("\\")) {
        return tooComplex("word with backslash escape is not supported", "word", "shell-escape");
      }
      return { kind: "ok", value: node.text };
    case "number":
      return { kind: "ok", value: node.text };
    case "raw_string": {
      // 'single quoted' — strip the surrounding quotes. Single-quoted
      // strings are truly literal in bash (no escape processing), so
      // backslashes inside are safe — the argv is exactly the inner text.
      const text = node.text;
      if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
        return { kind: "ok", value: text.slice(1, -1) };
      }
      return tooComplex("malformed raw_string", "raw_string", "malformed");
    }
    case "string": {
      // "double quoted" — allow only if children are [", string_content?, "]
      // AND string_content contains no backslashes. Bash processes `\"`,
      // `\\`, `\$`, `\``, and `\<newline>` inside double quotes, so any
      // backslash in string_content means the raw text lies about the argv.
      // Fail closed: reject rather than emulate escape resolution.
      const parts: string[] = [];
      for (const child of node.children) {
        if (child.type === '"') continue;
        if (child.type === "$") {
          // Literal `$` inside a double-quoted string — e.g. `"$"` or
          // `"foo$bar"` where `$bar` is not a valid expansion. Append
          // as literal text. (A `$` child directly inside `string` is
          // the bare-dollar case; interpolations like `"$VAR"` arrive
          // as a nested `simple_expansion` child instead.)
          parts.push("$");
          continue;
        }
        if (child.type === "string_content") {
          if (child.text.includes("\\")) {
            return tooComplex(
              "backslash escape in double-quoted string is not supported",
              "string_content",
              "shell-escape",
            );
          }
          parts.push(child.text);
          continue;
        }
        // Dynamic content inside a double-quoted string (simple_expansion /
        // expansion / command_substitution / etc.). The walker can't extract
        // a static argv, but it can route the rejection category by the
        // child's node type so callers see why the string failed.
        //
        // The `default` arm routes to `unknown` (not `unsupported-syntax`)
        // so that a future tree-sitter-bash grammar emitting a new child
        // node type for double-quoted strings surfaces as a drift signal
        // instead of being silently absorbed. Known-but-unhandled child
        // types MUST be added as explicit case arms above.
        // Tree-sitter-bash parse quirk: `"foo$ bar"` emits a
        // `simple_expansion` with text `$ bar`, but bash resolves the
        // `$` as a literal dollar sign (a space can't start an
        // identifier). Route these parse-quirk cases through as literal
        // text instead of treating them as scope-trackable expansions;
        // this keeps the argv correct and avoids false too-complex
        // rejections for fully static quoted strings.
        if (child.type === "simple_expansion" && !isRealExpansion(child.text)) {
          parts.push(child.text);
          continue;
        }
        let childCategory: TooComplexCategory;
        switch (child.type) {
          case "simple_expansion":
            childCategory = isSpecialParameter(child.text) ? "positional" : "scope-trackable";
            break;
          case "command_substitution":
            childCategory = "command-substitution";
            break;
          case "expansion":
            childCategory = "parameter-expansion";
            break;
          case "escape_sequence":
            // `"foo\nbar"` can emit a discrete `escape_sequence` child.
            // Raw source diverges from effective argv exactly like a
            // backslash inside `string_content` — hard-deny via
            // `shell-escape` to preserve the fail-closed invariant.
            childCategory = "shell-escape";
            break;
          case "arithmetic_expansion":
            // `"$((1+2))"` inside a double-quoted string. Same handling
            // as the standalone `arithmetic_expansion` case in walkArgNode
            // below — known but not implemented.
            childCategory = "unsupported-syntax";
            break;
          default:
            childCategory = "unknown";
            break;
        }
        return tooComplex(
          `dynamic content in double-quoted string: ${child.type}`,
          child.type,
          childCategory,
        );
      }
      return { kind: "ok", value: parts.join("") };
    }
    case "concatenation":
      return tooComplex(
        "adjacent-token concatenation is not supported",
        "concatenation",
        "unsupported-syntax",
      );
    case "simple_expansion": {
      const isPositional = isSpecialParameter(node.text);
      return tooComplex(
        "variable expansion ($VAR) is not supported",
        "simple_expansion",
        isPositional ? "positional" : "scope-trackable",
      );
    }
    case "expansion":
      return tooComplex(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: documenting bash syntax literally
        "parameter expansion (${VAR}) is not supported",
        "expansion",
        "parameter-expansion",
      );
    case "command_substitution":
      // `$(cmd)` / backticks execute arbitrary nested shell commands.
      // Scope tracking cannot safely rescue this shape (vs `$VAR` which
      // is a pure variable read), so route to a distinct category so
      // downstream approval logic can preserve the trust-boundary
      // distinction between variable reads and nested execution.
      return tooComplex(
        "command substitution $( ) is not supported",
        "command_substitution",
        "command-substitution",
      );
    case "process_substitution":
      return tooComplex(
        "process substitution <( ) is not supported",
        "process_substitution",
        "process-substitution",
      );
    case "arithmetic_expansion":
      return tooComplex(
        "arithmetic expansion $(( )) is not supported",
        "arithmetic_expansion",
        "unsupported-syntax",
      );
    case "brace_expression":
      return tooComplex(
        "brace expansion {a,b} is not supported",
        "brace_expression",
        "unsupported-syntax",
      );
    case "ansi_c_string":
      // $'\xNN' — ANSI-C escapes. Static but easy to use for obfuscation;
      // treat as too-complex so the regex prefilter catches the hex pattern.
      return tooComplex(
        "ANSI-C string $'...' is not supported",
        "ansi_c_string",
        "unsupported-syntax",
      );
    case "translated_string":
      // SECURITY: `$"..."` is bash locale translation. The displayed source
      // can expand to arbitrary text when a translation catalog is loaded,
      // and the enclosed payload can carry backslash escapes the walker
      // does not normalize. Treat as `shell-escape` so the hard-deny path
      // fires — approving this based on the raw text would be misleading.
      return tooComplex(
        'translated string $"..." is not supported',
        "translated_string",
        "shell-escape",
      );
    case "$":
      // Bare `$` is a literal dollar sign when it is NOT followed by a
      // `string` sibling. `walkCommand` pre-scans children to catch the
      // `$ + string` locale-translation split form and fails closed at
      // that level before we reach walkArgNode; by the time we get here
      // the `$` is safe to emit as the literal argv token `$`.
      return { kind: "ok", value: "$" };
    default:
      return tooComplex(`unsupported argument node: ${node.type}`, node.type, "unknown");
  }
}

/** Walk a `file_redirect` node. Children: optional file_descriptor, operator, target. */
function walkFileRedirect(node: Node):
  | { kind: "ok"; redirect: Redirect }
  | {
      kind: "too-complex";
      reason: string;
      nodeType?: string;
      primaryCategory: TooComplexCategory;
    } {
  let fd: number | undefined;
  let op: string | undefined;
  let targetNode: Node | null = null;

  for (const child of node.children) {
    if (child.type === "file_descriptor") {
      const parsed = Number.parseInt(child.text, 10);
      if (Number.isFinite(parsed)) fd = parsed;
      continue;
    }
    if (REDIRECT_OP_TYPES.has(child.type)) {
      op = child.type;
      continue;
    }
    if (op !== undefined && targetNode === null) {
      targetNode = child;
      continue;
    }
    return tooComplex(`unexpected child in file_redirect: ${child.type}`, child.type, "malformed");
  }

  if (op === undefined) {
    return tooComplex("file_redirect without operator", "file_redirect", "malformed");
  }
  if (targetNode === null) {
    return tooComplex("file_redirect without target", "file_redirect", "malformed");
  }
  const v = walkArgNode(targetNode);
  if (v.kind === "too-complex") return v;

  const redirect: Redirect =
    fd !== undefined
      ? { op: op as Redirect["op"], target: v.value, fd }
      : { op: op as Redirect["op"], target: v.value };
  return { kind: "ok", redirect };
}

function tooComplex(
  reason: string,
  nodeType: string | undefined,
  primaryCategory: TooComplexCategory,
): {
  kind: "too-complex";
  reason: string;
  nodeType?: string;
  primaryCategory: TooComplexCategory;
} {
  return nodeType !== undefined
    ? { kind: "too-complex", reason, nodeType, primaryCategory }
    : { kind: "too-complex", reason, primaryCategory };
}
