/**
 * Focused tests for parseStartFlags — only the convergence-loop flags
 * (#1624). The happy-path and interactive-mode flag parsing is already
 * covered implicitly via commands/start.test.ts and CLI manual testing.
 */

import { describe, expect, test } from "bun:test";
import { ParseError } from "./shared.js";
import { parseStartFlags } from "./start.js";

describe("parseStartFlags — --until-pass / --max-iter (#1624)", () => {
  test("no flag → untilPass is empty, maxIter defaults to 10", () => {
    const flags = parseStartFlags(["--prompt", "hi"]);
    expect(flags.untilPass).toEqual([]);
    expect(flags.maxIter).toBe(10);
  });

  test("single --until-pass token is collected as 1-element argv", () => {
    const flags = parseStartFlags([
      "--prompt",
      "fix it",
      "--until-pass",
      "bun",
      "--allow-side-effects",
    ]);
    expect(flags.untilPass).toEqual(["bun"]);
  });

  test("repeated --until-pass collects all tokens in order", () => {
    const flags = parseStartFlags([
      "--prompt",
      "fix the test",
      "--until-pass",
      "bun",
      "--until-pass",
      "test",
      "--until-pass",
      "--filter=foo",
      "--allow-side-effects",
    ]);
    expect(flags.untilPass).toEqual(["bun", "test", "--filter=foo"]);
  });

  test("--max-iter parses to integer", () => {
    const flags = parseStartFlags([
      "--prompt",
      "hi",
      "--until-pass",
      "bun",
      "--max-iter",
      "5",
      "--allow-side-effects",
    ]);
    expect(flags.maxIter).toBe(5);
  });

  test("--max-iter rejects non-integer", () => {
    expect(() => parseStartFlags(["--prompt", "hi", "--max-iter", "not-a-number"])).toThrow(
      ParseError,
    );
  });

  test("regression: --max-iter rejects strings with trailing junk (round 40)", () => {
    // parseInt("10abc", 10) returns 10 and silently discards the
    // trailing characters. The strict validator must reject this so
    // a user fat-finger on a safety-critical flag doesn't end up
    // running a different iteration count than they typed.
    expect(() => parseStartFlags(["--prompt", "hi", "--max-iter", "10abc"])).toThrow(ParseError);
  });

  test("regression: --verifier-timeout rejects strings with trailing junk (round 40)", () => {
    expect(() =>
      parseStartFlags([
        "--prompt",
        "hi",
        "--until-pass",
        "bun",
        "--allow-side-effects",
        "--verifier-timeout",
        "120000ms",
      ]),
    ).toThrow(ParseError);
  });

  test("--max-iter rejects zero / negative", () => {
    expect(() => parseStartFlags(["--prompt", "hi", "--max-iter", "0"])).toThrow(ParseError);
    expect(() => parseStartFlags(["--prompt", "hi", "--max-iter", "-1"])).toThrow(ParseError);
  });

  test("empty --until-pass token is rejected", () => {
    expect(() => parseStartFlags(["--prompt", "hi", "--until-pass", ""])).toThrow(ParseError);
  });

  test("--until-pass without --prompt is rejected (fail closed)", () => {
    // Safety flag: accepting it silently in interactive mode would run
    // the REPL without verifier enforcement. Parser must fail fast.
    expect(() => parseStartFlags(["--until-pass", "bun"])).toThrow(ParseError);
  });

  test("--until-pass combined with --resume is rejected (silent-state-loss guard)", () => {
    // Loop mode disables session-transcript persistence, so resuming a
    // loop run would silently drop its history. Parser must reject
    // the combination up front.
    expect(() =>
      parseStartFlags(["--prompt", "hi", "--until-pass", "bun", "--resume", "ses_abc"]),
    ).toThrow(ParseError);
  });

  test("--verifier-timeout parses to milliseconds with default 120_000", () => {
    const defaults = parseStartFlags([
      "--prompt",
      "hi",
      "--until-pass",
      "bun",
      "--allow-side-effects",
    ]);
    expect(defaults.verifierTimeoutMs).toBe(120_000);

    const custom = parseStartFlags([
      "--prompt",
      "hi",
      "--until-pass",
      "bun",
      "--verifier-timeout",
      "300000",
      "--allow-side-effects",
    ]);
    expect(custom.verifierTimeoutMs).toBe(300_000);
  });

  test("--verifier-timeout rejects non-integer", () => {
    expect(() =>
      parseStartFlags([
        "--prompt",
        "hi",
        "--until-pass",
        "bun",
        "--verifier-timeout",
        "not-a-number",
        "--allow-side-effects",
      ]),
    ).toThrow(ParseError);
  });

  test("--verifier-timeout rejects zero / negative", () => {
    expect(() =>
      parseStartFlags([
        "--prompt",
        "hi",
        "--until-pass",
        "bun",
        "--verifier-timeout",
        "0",
        "--allow-side-effects",
      ]),
    ).toThrow(ParseError);
  });

  test("workingDir is always undefined in loop mode (flag removed; cd before invoking koi)", () => {
    // Round 36 removed --working-dir from the CLI surface. The parser
    // no longer accepts the flag, and the workingDir field is hard-
    // coded to undefined — commands/start.ts falls back to process.cwd().
    // Users who need a different verifier root must cd before running
    // koi; the previous split-brain "flag-with-only-cwd-allowed"
    // workaround was removed because it was misleading documentation.
    const flags = parseStartFlags([
      "--prompt",
      "hi",
      "--until-pass",
      "bun",
      "--allow-side-effects",
    ]);
    expect(flags.workingDir).toBeUndefined();
  });

  test("--working-dir is rejected as an unknown flag (was removed in round 36)", () => {
    expect(() =>
      parseStartFlags([
        "--prompt",
        "hi",
        "--until-pass",
        "bun",
        "--working-dir",
        process.cwd(),
        "--allow-side-effects",
      ]),
    ).toThrow(ParseError);
  });

  test("--until-pass without --allow-side-effects is rejected (round-11 trust boundary guard)", () => {
    // Loop mode re-invokes the agent's full tool set on every retry and
    // runs the verifier outside the CLI permission/sandbox system. The
    // parser must force the user to acknowledge both implications before
    // proceeding.
    expect(() => parseStartFlags(["--prompt", "hi", "--until-pass", "bun"])).toThrow(ParseError);
  });

  test("--until-pass combined with --log-format json is rejected", () => {
    // Loop mode writes raw human-readable banners to stdout; mixing
    // them with JSON events would break machine parsing. Reject until
    // structured loop events are implemented.
    expect(() =>
      parseStartFlags([
        "--prompt",
        "hi",
        "--until-pass",
        "bun",
        "--allow-side-effects",
        "--log-format",
        "json",
      ]),
    ).toThrow(ParseError);
  });

  test("--until-pass with --log-format text is accepted", () => {
    // Positive case: text format is the default and is fully compatible
    // with loop mode's banner output.
    const flags = parseStartFlags([
      "--prompt",
      "hi",
      "--until-pass",
      "bun",
      "--allow-side-effects",
      "--log-format",
      "text",
    ]);
    expect(flags.logFormat).toBe("text");
    expect(flags.untilPass).toEqual(["bun"]);
  });

  test("--verifier-inherit-env defaults to false (secure-by-default)", () => {
    const flags = parseStartFlags([
      "--prompt",
      "hi",
      "--until-pass",
      "bun",
      "--allow-side-effects",
    ]);
    expect(flags.verifierInheritEnv).toBe(false);
  });

  test("--verifier-inherit-env: true is captured when explicitly passed", () => {
    const flags = parseStartFlags([
      "--prompt",
      "fix it",
      "--until-pass",
      "bun",
      "--until-pass",
      "test",
      "--allow-side-effects",
      "--verifier-inherit-env",
    ]);
    expect(flags.verifierInheritEnv).toBe(true);
  });

  test("--allow-side-effects is captured on the returned flags", () => {
    const without = parseStartFlags(["--prompt", "hi"]);
    expect(without.allowSideEffects).toBe(false);

    const withFlag = parseStartFlags([
      "--prompt",
      "hi",
      "--until-pass",
      "bun",
      "--allow-side-effects",
    ]);
    expect(withFlag.allowSideEffects).toBe(true);
  });
});
