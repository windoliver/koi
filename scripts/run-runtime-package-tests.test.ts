import { describe, expect, test } from "bun:test";
import { constants as osConstants } from "node:os";
import {
  buildCommands,
  resolveExitStatus,
  runCommands,
  runRuntimePackageTests,
  type SpawnSync,
  signalExitCode,
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

  test("omits forwarded args when none are supplied", () => {
    const commands = buildCommands("/repo", "/repo/pkg", []);

    expect(commands[1]).toEqual({
      cmd: [process.execPath, "test"],
      cwd: "/repo/pkg",
    });
  });
});

describe("signalExitCode", () => {
  test("returns 128 + signo for a known signal", () => {
    expect(signalExitCode("SIGTERM")).toBe(128 + osConstants.signals.SIGTERM);
  });

  test("falls back to 128 for an unknown signal", () => {
    expect(signalExitCode("SIGNOT_A_REAL_SIGNAL")).toBe(128);
  });
});

describe("resolveExitStatus", () => {
  test("prefers signalCode over exitCode", () => {
    expect(resolveExitStatus({ exitCode: 0, signalCode: "SIGINT" })).toBe(
      128 + osConstants.signals.SIGINT,
    );
  });

  test("returns 1 when both exitCode and signalCode are absent", () => {
    expect(resolveExitStatus({ exitCode: null, signalCode: null })).toBe(1);
  });

  test("returns the numeric exit code when set and no signal", () => {
    expect(resolveExitStatus({ exitCode: 42, signalCode: null })).toBe(42);
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
  test("does not run the test command when the build command fails", () => {
    const calls: string[] = [];
    const spawn: SpawnSync = (command) => {
      calls.push(command.cmd[1] ?? "");
      return calls.length === 1 ? { exitCode: 3 } : { exitCode: 0 };
    };

    const status = runRuntimePackageTests([], "/repo", "/repo/pkg", spawn);

    expect(status).toBe(3);
    expect(calls).toEqual(["run"]);
  });

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
