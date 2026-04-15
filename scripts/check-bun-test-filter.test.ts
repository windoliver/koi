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

  test("respects inline ignore marker", () => {
    const content = "bun test --filter=foo  # check:bun-test-filter-ignore";
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(0);
  });

  test("does not match --filter on a separate logical line", () => {
    const content = "bun test\n\n--filter=foo";
    const v = detectViolations("a.md", content);
    expect(v).toHaveLength(0);
  });
});
