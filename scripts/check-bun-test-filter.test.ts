import { describe, expect, test } from "bun:test";
import { detectViolations } from "./check-bun-test-filter.ts";

describe("detectViolations — positive cases", () => {
  test("flags simple `bun test --filter=<pkg>`", () => {
    const v = detectViolations("a.md", "bun test --filter=@koi/runtime");
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
  });

  test("flags `bun test <path> --filter=<pkg>` (positional before flag)", () => {
    const v = detectViolations(
      "a.md",
      "bun test packages/meta/runtime/src/__tests__/golden-replay.test.ts --filter=@koi/runtime",
    );
    expect(v).toHaveLength(1);
  });

  test("flags `bun test --watch --filter=<pkg>` (intervening flag)", () => {
    const v = detectViolations("a.md", "bun test --watch --filter=@koi/runtime");
    expect(v).toHaveLength(1);
  });

  test("flags `bun --watch test --filter=<pkg>` (Bun-level flag before subcommand)", () => {
    const v = detectViolations("a.md", "bun --watch test --filter=@koi/runtime");
    expect(v).toHaveLength(1);
  });

  test("flags `bun --cwd=<dir> test --filter=<pkg>` (= form for Bun flag)", () => {
    const v = detectViolations(
      "a.md",
      "bun --cwd=packages/meta/runtime test --filter=@koi/runtime",
    );
    expect(v).toHaveLength(1);
  });

  test("flags `bun --cwd <dir> test --filter=<pkg>` (space-separated value)", () => {
    const v = detectViolations(
      "a.md",
      "bun --cwd packages/meta/runtime test --filter=@koi/runtime",
    );
    expect(v).toHaveLength(1);
  });

  test("flags `bun -c <file> test --filter=<pkg>` (short value flag)", () => {
    const v = detectViolations("a.md", "bun -c bunfig.toml test --filter=@koi/runtime");
    expect(v).toHaveLength(1);
  });

  test("flags `bun --env-file <file> test --filter=<pkg>` (Codex round 6: unknown value flag)", () => {
    const v = detectViolations("a.md", "bun --env-file .env test --filter=@koi/runtime");
    expect(v).toHaveLength(1);
  });

  test("flags `bun --hot --watch test --filter=<pkg>` (multiple boolean flags)", () => {
    const v = detectViolations("a.md", "bun --hot --watch test --filter=@koi/runtime");
    expect(v).toHaveLength(1);
  });

  test("flags hypothetical future flag `bun --some-new-flag value test --filter=<pkg>`", () => {
    const v = detectViolations("a.md", "bun --some-new-flag somevalue test --filter=@koi/runtime");
    expect(v).toHaveLength(1);
  });

  test("flags inline Markdown code: `bun test --filter=<pkg>`", () => {
    const v = detectViolations("a.md", "Run `bun test --filter=@koi/runtime` from the root.");
    expect(v).toHaveLength(1);
  });

  test("flags double-quoted command", () => {
    const v = detectViolations("a.sh", '"bun test --filter=@koi/runtime"');
    expect(v).toHaveLength(1);
  });

  test("flags single-quoted command", () => {
    const v = detectViolations("a.sh", "'bun test --filter=@koi/runtime'");
    expect(v).toHaveLength(1);
  });

  test("flags `bun test --filter @koi/runtime` (space-separated --filter value)", () => {
    const v = detectViolations("a.md", "bun test --filter @koi/runtime");
    expect(v).toHaveLength(1);
  });

  test("flags multiline shell continuation", () => {
    const content = "bun test \\\n  --filter=@koi/runtime";
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
  });

  test("flags multiline with positional and continuation", () => {
    const content =
      "bun test \\\n  packages/meta/runtime/src/foo.test.ts \\\n  --filter=@koi/runtime";
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
  });

  test("reports correct line number when violation is later in file", () => {
    const content = ["# Header", "Some prose.", "", "bun test --filter=@koi/foo", ""].join("\n");
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(4);
  });

  test("flags multiple distinct violations", () => {
    const content = "bun test --filter=a\nbun test foo.test.ts --filter=b\n";
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(2);
  });
});

describe("detectViolations — negative cases", () => {
  test("allows `bun run test --filter=<pkg>` (canonical form)", () => {
    const v = detectViolations("a.md", "bun run test --filter=@koi/runtime");
    expect(v).toHaveLength(0);
  });

  test("allows `bun run test:pkg @koi/runtime` (blessed shorthand)", () => {
    const v = detectViolations("a.md", "bun run test:pkg @koi/runtime");
    expect(v).toHaveLength(0);
  });

  test("allows `bun test:integration` (script with colon)", () => {
    const v = detectViolations("a.md", "bun test:integration --filter=@koi/runtime");
    expect(v).toHaveLength(0);
  });

  test("allows `bun testfoo --filter` (different command name)", () => {
    const v = detectViolations("a.md", "bun testfoo --filter=foo");
    expect(v).toHaveLength(0);
  });

  test("allows `bunx test --filter` (bunx, not bun)", () => {
    const v = detectViolations("a.md", "bunx test --filter=foo");
    expect(v).toHaveLength(0);
  });

  test("allows `bun test` without --filter", () => {
    const v = detectViolations("a.md", "bun test packages/meta/runtime");
    expect(v).toHaveLength(0);
  });

  test("inline ignore marker does NOT suppress violations (no opt-out exists)", () => {
    // Codex round 5: inline opt-out makes the policy unenforceable. The
    // guard now has no marker bypass; exemption is path-based only.
    const samples = [
      "bun test --filter=foo  # check:bun-test-filter-ignore",
      "bun test --filter=foo // check:bun-test-filter-ignore",
      "bun test --filter=foo <!-- check:bun-test-filter-ignore -->",
    ];
    for (const sample of samples) {
      const v = detectViolations("a.md", sample);
      expect(v).toHaveLength(1);
    }
  });

  test("does not match --filter on a separate logical line", () => {
    const content = "bun test\n\n--filter=foo";
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(0);
  });

  test("does not match across shell command separators", () => {
    const v = detectViolations("a.md", "bun test ; echo --filter=foo");
    expect(v).toHaveLength(0);
  });

  test("allows `bun --watch run test --filter=<pkg>` (canonical with bun flag)", () => {
    const v = detectViolations("a.md", "bun --watch run test --filter=@koi/runtime");
    expect(v).toHaveLength(0);
  });

  test("allows `bun install` (different subcommand abandons walk)", () => {
    const v = detectViolations("a.md", "bun install --filter=@koi/runtime");
    expect(v).toHaveLength(0);
  });

  test("allows `bun create vite my-test --filter=foo` (subcommand `create`)", () => {
    const v = detectViolations("a.md", "bun create vite my-test --filter=foo");
    expect(v).toHaveLength(0);
  });

  test("allows `bun add @koi/runtime --filter` (subcommand `add`)", () => {
    const v = detectViolations("a.md", "bun add @koi/runtime --filter=foo");
    expect(v).toHaveLength(0);
  });

  test("allows `bun some-script.ts test --filter=x` (Codex round 8: bun runs script)", () => {
    const v = detectViolations("a.md", "bun some-script.ts test --filter=x");
    expect(v).toHaveLength(0);
  });

  test("allows prose mentioning bun and test --filter separately (Codex round 8)", () => {
    const v = detectViolations(
      "a.md",
      'Use "bun" and the phrase "test --filter=@koi/runtime" separately.',
    );
    expect(v).toHaveLength(0);
  });

  test("allows prose with `bun` and `test` as separate words", () => {
    const v = detectViolations(
      "a.md",
      "When you run bun on a Linux machine, the test --filter mechanism applies.",
    );
    expect(v).toHaveLength(0);
  });

  test("allows `bun ./scripts/foo.ts test --filter=x` (script path)", () => {
    const v = detectViolations("a.md", "bun ./scripts/foo.ts test --filter=x");
    expect(v).toHaveLength(0);
  });
});

describe("detectViolations — koi --until-pass argv reconstruction", () => {
  test("flags repeated `--until-pass` form (loop verifier with bun test --filter)", () => {
    const v = detectViolations(
      "a.md",
      "koi start --until-pass bun --until-pass test --until-pass --filter=@koi/runtime",
    );
    expect(v).toHaveLength(1);
  });

  test("flags multiline `--until-pass` argv across continuations", () => {
    const content = [
      'koi start -p "fix" \\',
      "  --until-pass bun \\",
      "  --until-pass test \\",
      "  --until-pass --filter=@koi/runtime",
    ].join("\n");
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
  });

  test("flags `--until-pass=<value>` form", () => {
    const v = detectViolations(
      "a.md",
      "koi start --until-pass=bun --until-pass=test --until-pass=--filter=@koi/runtime",
    );
    expect(v).toHaveLength(1);
  });

  test('flags quoted `--until-pass "bun test --filter=..."` (Codex round 7)', () => {
    // The CLI parser actually treats this as one literal argv token (broken
    // usage), but the guard still catches it via quote-normalization in
    // isBunTestWithFilter so neither the broken nor the working invocation
    // can land in docs/scripts.
    const v = detectViolations(
      "a.md",
      'koi start --until-pass "bun test --filter=@koi/runtime" --max-iter 3',
    );
    expect(v).toHaveLength(1);
  });

  test("flags single-quoted `--until-pass 'bun test --filter=...'`", () => {
    const v = detectViolations(
      "a.md",
      "koi start --until-pass 'bun test --filter=@koi/runtime' --max-iter 3",
    );
    expect(v).toHaveLength(1);
  });

  test("allows canonical `--until-pass bun --until-pass run --until-pass test --until-pass --filter=<pkg>`", () => {
    const v = detectViolations(
      "a.md",
      "koi start --until-pass bun --until-pass run --until-pass test --until-pass --filter=@koi/runtime",
    );
    expect(v).toHaveLength(0);
  });

  test("allows pytest verifier with no bun involvement", () => {
    const v = detectViolations(
      "a.md",
      "koi start --until-pass pytest --until-pass -k --until-pass foo",
    );
    expect(v).toHaveLength(0);
  });
});
