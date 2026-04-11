/**
 * Focused tests for parseTuiFlags — only the convergence-loop flags
 * (#1624). The happy-path and session-flag parsing is covered
 * implicitly by the TUI command tests.
 */

import { describe, expect, test } from "bun:test";
import { ParseError } from "./shared.js";
import { parseTuiFlags } from "./tui.js";

const GLOBAL = { version: false, help: false };

describe("parseTuiFlags — --until-pass / --max-iter (#1624)", () => {
  test("no flag → untilPass is empty, maxIter defaults to 10", () => {
    const flags = parseTuiFlags([], GLOBAL);
    expect(flags.untilPass).toEqual([]);
    expect(flags.maxIter).toBe(10);
    expect(flags.verifierTimeoutMs).toBe(120_000);
    expect(flags.allowSideEffects).toBe(false);
    expect(flags.verifierInheritEnv).toBe(false);
  });

  test("single --until-pass token is collected as 1-element argv", () => {
    const flags = parseTuiFlags(["--until-pass", "bun", "--allow-side-effects"], GLOBAL);
    expect(flags.untilPass).toEqual(["bun"]);
  });

  test("repeated --until-pass collects all tokens in order", () => {
    const flags = parseTuiFlags(
      [
        "--until-pass",
        "bun",
        "--until-pass",
        "test",
        "--until-pass",
        "--filter=foo",
        "--allow-side-effects",
      ],
      GLOBAL,
    );
    expect(flags.untilPass).toEqual(["bun", "test", "--filter=foo"]);
  });

  test("--max-iter parses to integer", () => {
    const flags = parseTuiFlags(
      ["--until-pass", "bun", "--max-iter", "5", "--allow-side-effects"],
      GLOBAL,
    );
    expect(flags.maxIter).toBe(5);
  });

  test("--max-iter rejects strings with trailing junk (strict)", () => {
    expect(() => parseTuiFlags(["--max-iter", "10abc"], GLOBAL)).toThrow(ParseError);
  });

  test("--max-iter rejects zero / negative", () => {
    expect(() => parseTuiFlags(["--max-iter", "0"], GLOBAL)).toThrow(ParseError);
    expect(() => parseTuiFlags(["--max-iter", "-1"], GLOBAL)).toThrow(ParseError);
  });

  test("--verifier-timeout parses milliseconds", () => {
    const flags = parseTuiFlags(
      ["--until-pass", "bun", "--verifier-timeout", "300000", "--allow-side-effects"],
      GLOBAL,
    );
    expect(flags.verifierTimeoutMs).toBe(300_000);
  });

  test("--verifier-timeout rejects trailing junk (strict)", () => {
    expect(() =>
      parseTuiFlags(
        ["--until-pass", "bun", "--verifier-timeout", "120000ms", "--allow-side-effects"],
        GLOBAL,
      ),
    ).toThrow(ParseError);
  });

  test("empty --until-pass token is rejected", () => {
    expect(() => parseTuiFlags(["--until-pass", ""], GLOBAL)).toThrow(ParseError);
  });

  test("--until-pass without --allow-side-effects is rejected (trust boundary guard)", () => {
    expect(() => parseTuiFlags(["--until-pass", "bun"], GLOBAL)).toThrow(ParseError);
  });

  test("--until-pass combined with --session is rejected (silent-state-loss guard)", () => {
    expect(() =>
      parseTuiFlags(
        ["--until-pass", "bun", "--session", "ses_abc", "--allow-side-effects"],
        GLOBAL,
      ),
    ).toThrow(ParseError);
  });

  test("--verifier-inherit-env is captured when explicitly passed", () => {
    const without = parseTuiFlags(["--until-pass", "bun", "--allow-side-effects"], GLOBAL);
    expect(without.verifierInheritEnv).toBe(false);
    const withFlag = parseTuiFlags(
      ["--until-pass", "bun", "--allow-side-effects", "--verifier-inherit-env"],
      GLOBAL,
    );
    expect(withFlag.verifierInheritEnv).toBe(true);
  });

  test("--allow-side-effects is captured on the returned flags", () => {
    const without = parseTuiFlags([], GLOBAL);
    expect(without.allowSideEffects).toBe(false);
    const withFlag = parseTuiFlags(["--until-pass", "bun", "--allow-side-effects"], GLOBAL);
    expect(withFlag.allowSideEffects).toBe(true);
  });
});
