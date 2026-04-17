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
    return tooComplex("tree-sitter parse error in source", "ERROR", "unknown");
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
        return tooComplex("multiple commands in redirected_statement", child.type, "unknown");
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
      return tooComplex("heredoc redirects are not supported", "heredoc_redirect", "unknown");
    }
    return tooComplex(
      `unexpected child in redirected_statement: ${child.type}`,
      child.type,
      "unknown",
    );
  }

  if (command === null) {
    return tooComplex(
      "redirected_statement with no inner command",
      "redirected_statement",
      "unknown",
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

  for (const child of node.children) {
    if (SEPARATOR_NODE_TYPES.has(child.type)) continue;
    if (child.type === "variable_assignment") {
      if (sawCommandName) {
        return tooComplex("variable assignment after command name", child.type, "unknown");
      }
      const ev = walkVariableAssignment(child);
      if (ev.kind === "too-complex") return ev;
      envVars.push(ev.value);
      continue;
    }
    if (child.type === "command_name") {
      const inner = child.children[0];
      if (inner === undefined) {
        return tooComplex("empty command_name", "command_name", "unknown");
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
        "unknown",
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
        return tooComplex("multiple values in variable_assignment", child.type, "unknown");
      }
      valueNode = child;
    }
  }

  if (name === null) {
    return tooComplex("variable_assignment without a name", "variable_assignment", "unknown");
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
        const POSITIONAL_PREFIXES = [
          "$1",
          "$2",
          "$3",
          "$4",
          "$5",
          "$6",
          "$7",
          "$8",
          "$9",
          "$@",
          "$*",
          "$#",
          "$?",
          "$!",
        ];
        let childCategory: TooComplexCategory;
        switch (child.type) {
          case "simple_expansion":
            childCategory = POSITIONAL_PREFIXES.some((p) => child.text.startsWith(p))
              ? "positional"
              : "scope-trackable";
            break;
          case "command_substitution":
            childCategory = "scope-trackable";
            break;
          case "expansion":
            childCategory = "parameter-expansion";
            break;
          default:
            childCategory = "unsupported-syntax";
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
      const POSITIONAL_PREFIXES = [
        "$1",
        "$2",
        "$3",
        "$4",
        "$5",
        "$6",
        "$7",
        "$8",
        "$9",
        "$@",
        "$*",
        "$#",
        "$?",
        "$!",
      ];
      const isPositional = POSITIONAL_PREFIXES.some((p) => node.text.startsWith(p));
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
      return tooComplex(
        "command substitution $( ) is not supported",
        "command_substitution",
        "scope-trackable",
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
      // $"..." — locale-translated strings. Not supported.
      return tooComplex(
        'translated string $"..." is not supported',
        "translated_string",
        "unsupported-syntax",
      );
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
    return tooComplex(`unexpected child in file_redirect: ${child.type}`, child.type, "unknown");
  }

  if (op === undefined) {
    return tooComplex("file_redirect without operator", "file_redirect", "unknown");
  }
  if (targetNode === null) {
    return tooComplex("file_redirect without target", "file_redirect", "unknown");
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
