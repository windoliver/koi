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

  test("command_substitution routes to scope-trackable", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand("echo $(date)");
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("scope-trackable");
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

  test("translated_string routes to unsupported-syntax", async () => {
    await initializeBashAst();
    // Note: tree-sitter-bash only emits `translated_string` when `$"..."`
    // is the command name (argv[0]) or a variable_assignment value; in a
    // plain argument position it splits into separate `$` + `string` nodes.
    const result = analyzeBashCommand('$"msg"');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });

  test("concatenation routes to unsupported-syntax", async () => {
    await initializeBashAst();
    const result = analyzeBashCommand('echo foo"$VAR"bar');
    expect(result.kind).toBe("too-complex");
    if (result.kind !== "too-complex") throw new Error("unreachable");
    expect(result.primaryCategory).toBe("unsupported-syntax");
  });
});
