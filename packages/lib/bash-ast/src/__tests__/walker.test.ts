/**
 * Walker tests — exercise the happy paths of the AST walker.
 *
 * These tests depend on the real web-tree-sitter parser being initialised.
 * Every test that expects `kind: "simple"` proves the walker successfully
 * extracted argv/envVars/redirects for that input.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { analyzeBashCommand, initializeBashAst } from "../index.js";

beforeAll(async () => {
  await initializeBashAst();
});

describe("walker — simple commands", () => {
  test("extracts argv for a bare command", () => {
    const result = analyzeBashCommand("echo hello");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.argv).toEqual(["echo", "hello"]);
  });

  test("extracts argv with flags", () => {
    const result = analyzeBashCommand("ls -la /tmp");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.argv).toEqual(["ls", "-la", "/tmp"]);
  });

  test("extracts argv with double-quoted static string", () => {
    const result = analyzeBashCommand('echo "hello world"');
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.argv).toEqual(["echo", "hello world"]);
  });

  test("extracts argv with single-quoted raw string", () => {
    const result = analyzeBashCommand("echo 'single quotes'");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.argv).toEqual(["echo", "single quotes"]);
  });

  test("extracts argv with number literal", () => {
    const result = analyzeBashCommand("sleep 5");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.argv).toEqual(["sleep", "5"]);
  });

  test("extracts empty-commands from empty input", () => {
    const result = analyzeBashCommand("");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands).toHaveLength(0);
  });
});

describe("walker — compound statements", () => {
  test("splits semicolon-separated commands", () => {
    const result = analyzeBashCommand("git status; git log");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]?.argv).toEqual(["git", "status"]);
    expect(result.commands[1]?.argv).toEqual(["git", "log"]);
  });

  test("splits pipeline into separate commands", () => {
    const result = analyzeBashCommand("ls | grep foo");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]?.argv).toEqual(["ls"]);
    expect(result.commands[1]?.argv).toEqual(["grep", "foo"]);
  });

  test("splits && list into separate commands", () => {
    const result = analyzeBashCommand("mkdir foo && cd foo");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]?.argv).toEqual(["mkdir", "foo"]);
    expect(result.commands[1]?.argv).toEqual(["cd", "foo"]);
  });
});

describe("walker — environment variables", () => {
  test("extracts leading env-var prefix on a command", () => {
    const result = analyzeBashCommand("FOO=bar cat file");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.argv).toEqual(["cat", "file"]);
    expect(result.commands[0]?.envVars).toEqual([{ name: "FOO", value: "bar" }]);
  });

  test("extracts multiple env-var assignments", () => {
    const result = analyzeBashCommand("FOO=bar BAZ=qux cmd arg");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.argv).toEqual(["cmd", "arg"]);
    expect(result.commands[0]?.envVars).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });

  test("rejects standalone variable_assignment at list level", () => {
    // At the container level, standalone VAR=val is not a command.
    // Decision 8A: no scope tracking; any list-level assignment → too-complex.
    const result = analyzeBashCommand("FOO=bar && echo done");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") return;
    expect(result.nodeType).toBe("variable_assignment");
  });

  test("rejects assignment-only command without an executable", () => {
    // A `FOO=bar` alone that tree-sitter wraps as a command with no argv
    // is rejected because bare env assignments (e.g. LD_PRELOAD) are
    // security-relevant.
    const result = analyzeBashCommand("LD_PRELOAD=/tmp/evil.so");
    expect(result.kind).toBe("too-complex");
  });
});

describe("walker — redirects", () => {
  test("extracts output redirect", () => {
    const result = analyzeBashCommand("cat file > out.txt");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    const cmd = result.commands[0];
    expect(cmd?.argv).toEqual(["cat", "file"]);
    expect(cmd?.redirects).toEqual([{ op: ">", target: "out.txt" }]);
  });

  test("extracts append redirect", () => {
    const result = analyzeBashCommand("echo log >> log.txt");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.redirects).toEqual([{ op: ">>", target: "log.txt" }]);
  });

  test("extracts input redirect", () => {
    const result = analyzeBashCommand("wc -l < input.txt");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") return;
    expect(result.commands[0]?.redirects).toEqual([{ op: "<", target: "input.txt" }]);
  });

  test("rejects heredoc redirect", () => {
    const result = analyzeBashCommand("cat <<EOF\nhello\nEOF");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") return;
    expect(result.nodeType).toBe("heredoc_redirect");
  });
});

describe("walker — rejects dynamic content (phase-1 scope)", () => {
  test("rejects command substitution $()", () => {
    const result = analyzeBashCommand("echo $(date)");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") return;
    expect(result.nodeType).toBe("command_substitution");
  });

  test("rejects simple expansion $VAR", () => {
    const result = analyzeBashCommand("echo $USER");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") return;
    expect(result.nodeType).toBe("simple_expansion");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: documenting bash syntax literally
  test("rejects parameter expansion ${VAR}", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash parameter expansion
    const result = analyzeBashCommand("echo ${HOME}");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects arithmetic expansion $(( ))", () => {
    const result = analyzeBashCommand("echo $((1 + 2))");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects process substitution <( )", () => {
    const result = analyzeBashCommand("diff <(ls a) <(ls b)");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects brace expansion {a,b}", () => {
    const result = analyzeBashCommand("cp file.{old,new}");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects for loop", () => {
    const result = analyzeBashCommand("for i in 1 2 3; do echo hi; done");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") return;
    expect(result.nodeType).toBe("for_statement");
  });

  test("rejects while loop", () => {
    const result = analyzeBashCommand("while true; do echo hi; done");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects if statement", () => {
    const result = analyzeBashCommand("if true; then echo hi; fi");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects case statement", () => {
    const result = analyzeBashCommand("case $1 in a) echo a;; esac");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects subshell", () => {
    const result = analyzeBashCommand("(cd /tmp && ls)");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects function definition", () => {
    const result = analyzeBashCommand("f() { echo hi; }");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects string with embedded expansion", () => {
    const result = analyzeBashCommand('echo "hello $name"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") return;
    expect(result.nodeType).toBe("simple_expansion");
  });

  test("rejects ANSI-C string $'...'", () => {
    const result = analyzeBashCommand("echo $'\\x68\\x69'");
    expect(result.kind).toBe("too-complex");
  });

  test("rejects concatenated tokens", () => {
    const result = analyzeBashCommand('echo "hello"world');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") return;
    expect(result.nodeType).toBe("concatenation");
  });

  test("simple_expansion $VAR routes to scope-trackable", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $X");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("scope-trackable");
  });

  test("simple_expansion $1 routes to positional", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $1");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  test("simple_expansion $1suffix routes to positional (prefix rule)", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $1suffix");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  test("command_substitution routes to command-substitution (distinct from $VAR reads)", async () => {
    await initializeBashAst();
    // Round-10 adversarial finding: $(cmd) executes arbitrary nested
    // shell code while $VAR is just a variable read. Keep them in
    // separate categories so approval UIs/logic can preserve the
    // trust-boundary distinction.
    const result = analyzeBashCommand("echo $(date)");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("command-substitution");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: documenting bash syntax literally
  test("expansion ${X:-def} routes to parameter-expansion", async () => {
    await initializeBashAst();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash parameter expansion
    const result = analyzeBashCommand("echo ${X:-def}");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("parameter-expansion");
  });

  test("process_substitution routes to process-substitution", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("cat <(echo hi)");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("process-substitution");
  });

  test("arithmetic_expansion routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $(( 1 + 2 ))");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("brace_expression routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo {a,b}");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("ansi_c_string routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $'a\\nb'");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("translated_string routes to shell-escape (locale-translation ambiguity)", async () => {
    await initializeBashAst();
    // Note: tree-sitter-bash only emits `translated_string` when `$"..."`
    // is the command name (argv[0]) or a variable_assignment value; in a
    // plain argument position it splits into separate `$` + `string` nodes.
    // Hard-deny via shell-escape: bash locale translation may expand the
    // raw source to arbitrary text (round-6 adversarial finding).
    const result = analyzeBashCommand('$"msg"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("shell-escape");
  });

  test("concatenation routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo foo"$VAR"bar');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("word with backslash routes to shell-escape", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("cat \\/etc\\/passwd");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("shell-escape");
  });

  test("string_content with backslash routes to shell-escape", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "foo\\nbar"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("shell-escape");
  });

  test("double-quoted scope-trackable child routes via child.type", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "prefix$VAR"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("scope-trackable");
  });

  test("double-quoted command_substitution child routes to command-substitution", async () => {
    await initializeBashAst();
    // Matches the standalone $(cmd) case: nested execution is distinct
    // from a pure variable read even when it appears inside a string.
    const result = analyzeBashCommand('echo "prefix$(date)"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("command-substitution");
  });

  test("double-quoted expansion child routes via child.type", async () => {
    await initializeBashAst();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: documenting bash syntax literally
    const result = analyzeBashCommand('echo "prefix${X:-def}"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("parameter-expansion");
  });

  test("double-quoted positional child routes as positional", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "prefix$1suffix"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  test("if_statement routes to control-flow", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("if true; then echo hi; fi");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("control-flow");
  });

  test("for_statement routes to control-flow", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("for i in *; do echo $i; done");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("control-flow");
  });

  test("while_statement routes to control-flow", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("while true; do break; done");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("control-flow");
  });

  test("case_statement routes to control-flow", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("case x in a) echo a ;; esac");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("control-flow");
  });

  test("function_definition routes to control-flow", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("f() { echo hi; }");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("control-flow");
  });

  test("subshell routes to control-flow", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("(echo hi)");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("control-flow");
  });

  test("top-level variable_assignment routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("FOO=bar && echo done");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("top-level variable_assignments (plural) routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("A=1 B=2 && true");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("declaration_command routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("export X=1; echo hi");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("heredoc_redirect routes to heredoc", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("cat <<EOF\nhi\nEOF");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("heredoc");
  });

  test("unterminated string routes to parse-error", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "unterminated');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("parse-error");
  });

  test("line continuation routes to shell-escape via analyze.ts prefilter", async () => {
    await initializeBashAst();
    // JS source `"echo foo\\\nbar"` → bash sees backslash + newline + "bar" (line continuation).
    // Triggers LINE_CONTINUATION_RE in analyze.ts BEFORE the walker runs.
    const result = analyzeBashCommand("echo foo\\\nbar");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("shell-escape");
  });

  // Special-parameter regression coverage. Bash special parameters beyond
  // the original $1..$9/$@/$*/$#/$?/$! set — $0, $$, $-, $_ — must route to
  // `positional` (not `scope-trackable`) because they depend on
  // shell/process state, not tracked environment scope.
  test("simple_expansion $0 routes to positional", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $0");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  test("simple_expansion $$ routes to positional", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $$");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  test("simple_expansion $- routes to positional", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $-");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  test("simple_expansion $_ routes to positional", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $_");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  test("double-quoted $$ routes to positional (via site 273 dispatch)", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "$$"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("positional");
  });

  // Bare `$` in argument position. Tree-sitter-bash splits `echo $"msg"`
  // (argument position) into `$` + `string` children — the `$` child lands
  // in walkArgNode's new `case "$":` arm. Prior to the fix this hit the
  // default and incorrectly produced `unknown`.
  test('bare $ in argument position (echo $"msg") routes to shell-escape', async () => {
    await initializeBashAst();
    // Round-6 adversarial finding: locale-translated strings carry the same
    // escape-ambiguity risk as backslash escapes in ordinary strings, and
    // the walker short-circuits at the bare `$` before inspecting its
    // sibling string for embedded backslashes. Hard-deny via shell-escape
    // rather than passing through to elicit/regex fallback.
    const result = analyzeBashCommand('echo $"msg"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("shell-escape");
  });

  // `$_x` is the bash variable reference `_x` (underscore is a valid
  // identifier start), NOT the special parameter `$_` followed by literal
  // `x`. The round-3 adversarial finding showed that a naive
  // `startsWith("$_")` check folded these into positional. The regex
  // helper must distinguish `$_` (alone or punctuation-terminated) from
  // `$_[A-Za-z0-9_]…` which is a regular variable expansion.
  test("simple_expansion $_x routes to scope-trackable (variable, not special param)", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $_x");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("scope-trackable");
  });

  test("simple_expansion $_abc routes to scope-trackable", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $_abc");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("scope-trackable");
  });

  test("double-quoted $_x routes to scope-trackable (not positional)", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "$_x"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("scope-trackable");
  });

  // Round-6 regression: locale-translated strings whose payload carries a
  // backslash escape MUST hard-deny via shell-escape, not leak through to
  // elicit. Both the arg-position split (`$` + string) and the
  // command-name form (`translated_string`) must fail closed.
  test('escape-bearing $"a\\"b" in argument position hard-denies via shell-escape', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo $"a\\"b"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("shell-escape");
  });

  test('escape-bearing $"a\\"b" as command_name hard-denies via shell-escape', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('$"a\\"b" foo');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("shell-escape");
  });

  // Round-8 regression: a bare `$` without a sibling `string` is a literal
  // dollar sign in bash (`echo $` prints `$`), NOT locale-translation
  // syntax. `walkCommand`'s pre-scan catches the `$ + string` split form;
  // any remaining bare `$` is a literal argv token. Similarly, a `$` child
  // directly inside a double-quoted string (`"$"`, `"foo$ "`) is literal.
  // Prior to the fix these routed to shell-escape / unknown and falsely
  // hard-denied or bounced through elicit.
  test("literal $ at end of argv stays simple (echo $)", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") throw new Error("unreachable");
    expect(result.commands[0]?.argv).toEqual(["echo", "$"]);
  });

  test('literal $ inside double-quoted string stays simple (echo "$")', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "$"');
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") throw new Error("unreachable");
    expect(result.commands[0]?.argv).toEqual(["echo", "$"]);
  });

  test("literal $ followed by whitespace-separated word stays simple (echo $ foo)", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $ foo");
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") throw new Error("unreachable");
    expect(result.commands[0]?.argv).toEqual(["echo", "$", "foo"]);
  });

  // Round-9 regression: the `$+string` locale-translation detector must
  // require BYTE adjacency. `echo $ "msg"` has whitespace between the
  // `$` and the string — two separate argv elements, NOT `$"..."`.
  // Relying on sibling order alone falsely hard-denied this case.
  test('literal $ followed by separate quoted arg stays simple (echo $ "msg")', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo $ "msg"');
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") throw new Error("unreachable");
    expect(result.commands[0]?.argv).toEqual(["echo", "$", "msg"]);
  });

  test('literal $ followed by multi-space quoted arg stays simple (echo $  "msg")', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo $  "msg"');
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") throw new Error("unreachable");
    expect(result.commands[0]?.argv).toEqual(["echo", "$", "msg"]);
  });

  // Fresh-loop regression: tree-sitter-bash emits `simple_expansion`
  // inside double-quoted strings for shapes bash resolves literally —
  // e.g. `"foo$ bar"` produces `simple_expansion "$ bar"` with a
  // variable_name of `" bar"`. bash treats the `$` as a literal dollar
  // because a space can't start an identifier, so the argv is static.
  // The walker now passes these parse-quirk cases through as literal
  // text instead of falsely routing them to scope-trackable.
  test('literal $ before whitespace inside quotes stays simple (echo "foo$ bar")', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "foo$ bar"');
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") throw new Error("unreachable");
    expect(result.commands[0]?.argv).toEqual(["echo", "foo$ bar"]);
  });

  test('literal $ at start of quoted content stays simple (echo "$ foo")', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "$ foo"');
    expect(result.kind).toBe("simple");
    if (result.kind !== "simple") throw new Error("unreachable");
    expect(result.commands[0]?.argv).toEqual(["echo", "$ foo"]);
  });

  // Fresh-loop round-2 regression: quoted `$((...))` must route to
  // unsupported-syntax, matching the standalone case. Previously the
  // string-child dispatch's default arm sent it to `unknown`,
  // falsely flagging valid bash as grammar drift.
  test('arithmetic_expansion inside quotes routes to unsupported-syntax (echo "$((1+2))")', async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo "$((1+2))"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test('real expansion inside quotes still routes to scope-trackable (echo "$foo")', async () => {
    await initializeBashAst();
    // Belt-and-suspenders: a real variable reference must still be
    // rejected; only parse-quirk literals get passed through.
    const result = analyzeBashCommand('echo "$foo"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("scope-trackable");
  });
});
