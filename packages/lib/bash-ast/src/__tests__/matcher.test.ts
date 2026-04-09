/**
 * matcher.test.ts — pure unit tests for matchSimpleCommand().
 *
 * No parser needed — tests operate on hand-constructed SimpleCommand
 * fixtures and BashRulePattern shapes directly.
 */

import { describe, expect, test } from "bun:test";
import type { BashRulePattern } from "@koi/core/bash-rule-pattern";
import { matchSimpleCommand } from "../matcher.js";
import type { SimpleCommand } from "../types.js";

function cmd(argv: readonly string[]): SimpleCommand {
  return { argv, envVars: [], redirects: [], text: argv.join(" ") };
}

describe("matchSimpleCommand — argv0 only", () => {
  test("literal match", () => {
    expect(matchSimpleCommand({ argv0: "git" }, cmd(["git"]))).toBe(true);
    expect(matchSimpleCommand({ argv0: "git" }, cmd(["git", "status"]))).toBe(true);
    expect(matchSimpleCommand({ argv0: "git" }, cmd(["hg"]))).toBe(false);
  });

  test("regex match", () => {
    expect(matchSimpleCommand({ argv0: /^git/ }, cmd(["git"]))).toBe(true);
    expect(matchSimpleCommand({ argv0: /^git/ }, cmd(["git-lfs"]))).toBe(true);
    expect(matchSimpleCommand({ argv0: /^git/ }, cmd(["digit"]))).toBe(false);
  });

  test("empty argv never matches", () => {
    expect(matchSimpleCommand({ argv0: "git" }, cmd([]))).toBe(false);
  });
});

describe("matchSimpleCommand — strict args", () => {
  test("exact match", () => {
    const pat: BashRulePattern = { argv0: "git", args: ["status"] };
    expect(matchSimpleCommand(pat, cmd(["git", "status"]))).toBe(true);
    expect(matchSimpleCommand(pat, cmd(["git", "status", "--porcelain"]))).toBe(false);
    expect(matchSimpleCommand(pat, cmd(["git"]))).toBe(false);
  });

  test("rejects longer argv (strict length)", () => {
    const pat: BashRulePattern = { argv0: "git", args: ["status"] };
    expect(matchSimpleCommand(pat, cmd(["git", "status", "extra"]))).toBe(false);
  });

  test("regex element in args", () => {
    const pat: BashRulePattern = { argv0: "git", args: ["status", /^--/] };
    expect(matchSimpleCommand(pat, cmd(["git", "status", "--porcelain"]))).toBe(true);
    expect(matchSimpleCommand(pat, cmd(["git", "status", "hello"]))).toBe(false);
  });
});

describe("matchSimpleCommand — prefix args", () => {
  test("prefix match allows trailing tail", () => {
    const pat: BashRulePattern = { argv0: "git", argsPrefix: ["status"] };
    expect(matchSimpleCommand(pat, cmd(["git", "status"]))).toBe(true);
    expect(matchSimpleCommand(pat, cmd(["git", "status", "--porcelain"]))).toBe(true);
    expect(matchSimpleCommand(pat, cmd(["git", "status", "--porcelain", "-v"]))).toBe(true);
  });

  test("rejects argv shorter than prefix", () => {
    const pat: BashRulePattern = { argv0: "git", argsPrefix: ["status", "--porcelain"] };
    expect(matchSimpleCommand(pat, cmd(["git", "status"]))).toBe(false);
    expect(matchSimpleCommand(pat, cmd(["git"]))).toBe(false);
  });

  test("empty argsPrefix matches any tail", () => {
    const pat: BashRulePattern = { argv0: "git", argsPrefix: [] };
    expect(matchSimpleCommand(pat, cmd(["git"]))).toBe(true);
    expect(matchSimpleCommand(pat, cmd(["git", "status"]))).toBe(true);
  });
});

describe("matchSimpleCommand — pattern bugs fail closed", () => {
  test("both args and argsPrefix → no match", () => {
    const pat: BashRulePattern = {
      argv0: "git",
      args: ["status"],
      argsPrefix: ["status"],
    };
    expect(matchSimpleCommand(pat, cmd(["git", "status"]))).toBe(false);
  });
});
