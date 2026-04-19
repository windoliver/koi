import { describe, expect, test } from "bun:test";
import { type EvaluateInput, evaluateBashCommand } from "./evaluate.js";
import { BUILTIN_SPECS } from "./registry.js";

function input(
  argv: readonly string[],
  envVars: EvaluateInput["envVars"] = [],
  redirects: EvaluateInput["redirects"] = [],
): EvaluateInput {
  return { argv, envVars, redirects };
}

describe("evaluateBashCommand — happy path", () => {
  test("forwards complete result with no redirects/env", () => {
    const result = evaluateBashCommand(input(["rm", "foo"]), BUILTIN_SPECS);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["foo"]);
  });

  test("propagates refused from underlying spec", () => {
    const result = evaluateBashCommand(input(["rm"]), BUILTIN_SPECS);
    expect(result.kind).toBe("refused");
  });

  test("returns refused when no spec registered for argv[0]", () => {
    const result = evaluateBashCommand(input(["git", "status"]), BUILTIN_SPECS);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });
});

describe("evaluateBashCommand — redirects merged into semantics", () => {
  test("`> /tmp/out` is added to writes (still complete: redirect fully modeled)", () => {
    const result = evaluateBashCommand(
      input(["curl", "https://example.com/"], [], [{ op: ">", target: "/tmp/out" }]),
      BUILTIN_SPECS,
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["/tmp/out"]);
  });

  test("`>> file` is added to writes", () => {
    const result = evaluateBashCommand(
      input(["rm", "foo"], [], [{ op: ">>", target: "log.txt" }]),
      BUILTIN_SPECS,
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["foo", "log.txt"]);
  });

  test("`< input` is added to reads", () => {
    const result = evaluateBashCommand(
      input(["curl", "https://example.com/"], [], [{ op: "<", target: "body.json" }]),
      BUILTIN_SPECS,
    );
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["body.json"]);
  });

  test("FD-duplication redirects (>&, <&) downgrade to partial without merging", () => {
    const result = evaluateBashCommand(
      input(["rm", "foo"], [], [{ op: ">&", target: "1" }]),
      BUILTIN_SPECS,
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("shell-redirect-fd-or-unknown-op");
  });

  test("here-string `<<<` does NOT add target to reads (regression: target is inline data, not a path)", () => {
    const result = evaluateBashCommand(
      input(["rm", "foo"], [], [{ op: "<<<", target: "secret" }]),
      BUILTIN_SPECS,
    );
    // `<<<` is unmodeled (inline stdin data), so the result is partial
    // with no `secret` in reads.
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("shell-redirect-fd-or-unknown-op");
    expect(result.semantics.reads).toEqual([]);
  });
});

describe("evaluateBashCommand — path-qualified argv[0] is REFUSED (consumer must pre-canonicalize)", () => {
  test("refuses /bin/rm (even trusted path; consumer must rewrite to bare name)", () => {
    const result = evaluateBashCommand(input(["/bin/rm", "foo"]), BUILTIN_SPECS);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
    expect(result.detail).toMatch(/bare command name/);
  });

  test("refuses /tmp/rm (untrusted path — would be wrapper)", () => {
    const result = evaluateBashCommand(input(["/tmp/rm", "foo"]), BUILTIN_SPECS);
    expect(result.kind).toBe("refused");
  });

  test("refuses ./rm (relative path)", () => {
    const result = evaluateBashCommand(input(["./rm", "foo"]), BUILTIN_SPECS);
    expect(result.kind).toBe("refused");
  });

  test("refuses argv[0] = '/' (no basename)", () => {
    const result = evaluateBashCommand(input(["/"]), BUILTIN_SPECS);
    expect(result.kind).toBe("refused");
  });

  test("refuses unknown bare command name", () => {
    const result = evaluateBashCommand(input(["git", "status"]), BUILTIN_SPECS);
    expect(result.kind).toBe("refused");
  });
});

describe("evaluateBashCommand — verifiedBaseName opt-in", () => {
  test("accepts /bin/rm when consumer passes verifiedBaseName", () => {
    const result = evaluateBashCommand(input(["/bin/rm", "foo"]), BUILTIN_SPECS, {
      verifiedBaseName: "rm",
    });
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["foo"]);
  });

  test("accepts /usr/local/bin/curl when consumer passes verifiedBaseName", () => {
    const result = evaluateBashCommand(
      input(["/usr/local/bin/curl", "https://example.com/"]),
      BUILTIN_SPECS,
      { verifiedBaseName: "curl" },
    );
    expect(result.kind).toBe("complete");
  });

  test("verifiedBaseName must match argv[0]'s basename (sanity check)", () => {
    const result = evaluateBashCommand(input(["/bin/cp", "src", "dst"]), BUILTIN_SPECS, {
      verifiedBaseName: "rm",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/does not match argv\[0\] basename/);
  });

  test("verifiedBaseName must match bare argv[0] too", () => {
    const result = evaluateBashCommand(input(["whatever"]), BUILTIN_SPECS, {
      verifiedBaseName: "rm",
    });
    expect(result.kind).toBe("refused");
  });

  test("verifiedBaseName not in registry → refused with that name in detail", () => {
    const result = evaluateBashCommand(input(["/bin/git", "status"]), BUILTIN_SPECS, {
      verifiedBaseName: "git",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toContain("git");
  });
});

describe("evaluateBashCommand — env vars downgrade to partial", () => {
  test("non-empty envVars downgrades complete → partial", () => {
    const result = evaluateBashCommand(
      input(["curl", "https://example.com/"], [{ name: "HTTPS_PROXY", value: "http://proxy" }]),
      BUILTIN_SPECS,
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("command-local-env-set");
  });

  test("empty envVars and empty redirects keep complete", () => {
    const result = evaluateBashCommand(input(["chmod", "755", "foo"]), BUILTIN_SPECS);
    expect(result.kind).toBe("complete");
  });

  test("env + redirect joins both reasons", () => {
    const result = evaluateBashCommand(
      input(
        ["curl", "https://example.com/"],
        [{ name: "HOME", value: "/x" }],
        [{ op: ">", target: "/tmp/out" }],
      ),
      BUILTIN_SPECS,
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toContain("command-local-env-set");
    expect(result.semantics.writes).toEqual(["/tmp/out"]);
  });
});

describe("evaluateBashCommand — partial reason composition", () => {
  test("underlying partial reason is preserved alongside env/redirect markers", () => {
    const result = evaluateBashCommand(
      input(["wget", "https://example.com/"], [{ name: "HTTPS_PROXY", value: "p" }]),
      BUILTIN_SPECS,
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toContain("wget-follows-redirects");
    expect(result.reason).toContain("command-local-env-set");
  });
});
