import { describe, expect, test } from "bun:test";
import {
  buildCommands,
  runCommands,
  runRuntimePackageTests,
  type SpawnSync,
} from "./run-runtime-package-tests.ts";

describe("buildCommands", () => {
  test("builds runtime and its workspace deps before running package tests", () => {
    const commands = buildCommands("/repo", "/repo/packages/meta/runtime", [
      "src/create-runtime.test.ts",
      "--bail",
    ]);

    expect(commands).toEqual([
      {
        cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
        cwd: "/repo",
      },
      {
        cmd: [process.execPath, "test", "src/create-runtime.test.ts", "--bail"],
        cwd: "/repo/packages/meta/runtime",
      },
    ]);
  });
});

describe("runCommands", () => {
  test("stops after the first failing command", () => {
    const seen: string[] = [];
    const spawn: SpawnSync = (command) => {
      seen.push(command.cwd);
      return seen.length === 1 ? { exitCode: 7 } : { exitCode: 0 };
    };

    const status = runCommands(
      [
        { cmd: ["a"], cwd: "/repo" },
        { cmd: ["b"], cwd: "/repo/packages/meta/runtime" },
      ],
      spawn,
    );

    expect(status).toBe(7);
    expect(seen).toEqual(["/repo"]);
  });
});

describe("runRuntimePackageTests", () => {
  test("runs build first, then tests from the runtime package dir", () => {
    const calls: Array<{ readonly cmd: readonly string[]; readonly cwd: string }> = [];
    const spawn: SpawnSync = (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const status = runRuntimePackageTests(
      ["src/__tests__/golden-replay.test.ts"],
      "/repo",
      "/repo/packages/meta/runtime",
      spawn,
    );

    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
        cwd: "/repo",
      },
      {
        cmd: [process.execPath, "test", "src/__tests__/golden-replay.test.ts"],
        cwd: "/repo/packages/meta/runtime",
      },
    ]);
  });
});
