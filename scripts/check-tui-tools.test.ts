import { describe, expect, test } from "bun:test";
import {
  findMissingGoldenTools,
  formatMissingGoldenToolsMessage,
  runCheckTuiToolsCli,
} from "./check-tui-tools.js";

describe("findMissingGoldenTools", () => {
  test("passes when tools are present across combined TUI wiring sources", () => {
    const source = [
      'const systemPrompt = "Use TodoWrite for multi-step tasks";',
      'const tools = ["task_create"];',
      'const providerComment = "task_delegate is contributed by execution stack";',
    ].join("\n");

    expect(findMissingGoldenTools(source)).toEqual([]);
  });

  test("reports golden tools missing from the scanned source", () => {
    const source = 'const tools = ["TodoWrite", "task_create"];';

    expect(findMissingGoldenTools(source)).toEqual(["task_delegate"]);
  });

  test("formats actionable failure output", () => {
    const message = formatMissingGoldenToolsMessage(["task_delegate"]);

    expect(message).toContain("task_delegate");
    expect(message).toContain("packages/meta/cli/src/preset-stacks/execution.ts");
  });

  test("CLI runner writes success for the current TUI wiring source", () => {
    const stdout: string[] = [];

    runCheckTuiToolsCli({ stdout: (message) => stdout.push(message) });

    expect(stdout).toEqual(["✅ TUI has all 3 golden query tools wired."]);
  });

  test("CLI runner reports failure and exits nonzero for missing tools", () => {
    const stderr: string[] = [];
    let exitCode: number | undefined;

    expect(() =>
      runCheckTuiToolsCli({
        sourceText: 'const tools = ["TodoWrite"];',
        stderr: (message) => stderr.push(message),
        exit: (code) => {
          exitCode = code;
          throw new Error("exit");
        },
      }),
    ).toThrow("exit");

    expect(exitCode).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("task_create");
    expect(stderr[0]).toContain("task_delegate");
  });
});
