import { describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildCommands,
  type CommandSpec,
  createNoCoverageBunfig,
  resolveExitStatus,
  runCommands,
  runRuntimeGoldenReplay,
  spawnCommand,
} from "./run-runtime-golden-replay.js";

describe("createNoCoverageBunfig", () => {
  test("writes a bunfig.toml that disables coverage", () => {
    const bunfigPath = createNoCoverageBunfig();

    try {
      expect(existsSync(bunfigPath)).toBe(true);
      expect(readFileSync(bunfigPath, "utf8")).toContain("coverage = false");
    } finally {
      rmSync(dirname(bunfigPath), { force: true, recursive: true });
    }
  });
});

describe("buildCommands", () => {
  test("builds @koi/runtime then runs golden-replay from repo root with --config", () => {
    const commands = buildCommands("/repo", "/tmp/bunfig.toml", []);

    expect(commands).toEqual([
      {
        cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
        cwd: "/repo",
      },
      {
        cmd: [
          process.execPath,
          "--config=/tmp/bunfig.toml",
          "test",
          "/repo/packages/meta/runtime/src/__tests__/golden-replay.test.ts",
        ],
        cwd: "/repo",
      },
    ]);
  });

  test("forwards extra Bun test arguments to golden-replay", () => {
    const commands = buildCommands("/repo", "/tmp/bunfig.toml", [
      "-t",
      "middleware-feedback-loop|middleware-semantic-retry",
    ]);

    expect(commands[1]).toEqual({
      cmd: [
        process.execPath,
        "--config=/tmp/bunfig.toml",
        "test",
        "/repo/packages/meta/runtime/src/__tests__/golden-replay.test.ts",
        "-t",
        "middleware-feedback-loop|middleware-semantic-retry",
      ],
      cwd: "/repo",
    });
  });
});

describe("resolveExitStatus", () => {
  test("returns the child's exit code on a normal exit", () => {
    expect(resolveExitStatus({ exitCode: 0 })).toBe(0);
    expect(resolveExitStatus({ exitCode: 2 })).toBe(2);
  });

  test("returns 128 when the child was killed by a signal", () => {
    expect(resolveExitStatus({ exitCode: null, signalCode: "SIGTERM" })).toBe(128);
  });

  test("returns 1 when the child has neither a code nor a signal", () => {
    expect(resolveExitStatus({ exitCode: null })).toBe(1);
    expect(resolveExitStatus({ exitCode: null, signalCode: null })).toBe(1);
  });
});

describe("runCommands", () => {
  test("runs commands in order", () => {
    const seen: CommandSpec[] = [];

    runCommands(
      [
        { cmd: ["bun", "run", "build"], cwd: "/repo" },
        { cmd: ["bun", "test", "/repo/test.ts"], cwd: "/repo" },
      ],
      (command) => {
        seen.push(command);
        return { exitCode: 0 };
      },
    );

    expect(seen).toEqual([
      { cmd: ["bun", "run", "build"], cwd: "/repo" },
      { cmd: ["bun", "test", "/repo/test.ts"], cwd: "/repo" },
    ]);
  });

  test("propagates a signaled subprocess as a non-zero exit", () => {
    const exitSpy = mock((_code?: string | number | null | undefined) => {
      throw new Error("process.exit called");
    });
    const originalExit = process.exit;
    process.exit = exitSpy as unknown as typeof process.exit;

    try {
      expect(() =>
        runCommands([{ cmd: ["bun", "test"], cwd: "/repo" }], () => ({
          exitCode: null,
          signalCode: "SIGTERM",
        })),
      ).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(128);
    } finally {
      process.exit = originalExit;
    }
  });
});

describe("spawnCommand", () => {
  test("runs a Bun subprocess in the provided cwd", () => {
    const result = spawnCommand({
      cmd: [process.execPath, "-e", "process.exit(0)"],
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
  });
});

describe("runRuntimeGoldenReplay", () => {
  test("creates a bunfig and removes its dir around the targeted commands", () => {
    const spawn = mock(() => ({ exitCode: 0 }));
    const createBunfig = mock(() => "/tmp/koi-runtime-golden-replay/bunfig.toml");
    const removeBunfig = mock(() => {});

    runRuntimeGoldenReplay(
      ["-t", "Golden: feedback-loop"],
      "/repo",
      createBunfig,
      removeBunfig,
      spawn,
    );

    expect(createBunfig).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenNthCalledWith(1, {
      cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
      cwd: "/repo",
    });
    expect(spawn).toHaveBeenNthCalledWith(2, {
      cmd: [
        process.execPath,
        "--config=/tmp/koi-runtime-golden-replay/bunfig.toml",
        "test",
        "/repo/packages/meta/runtime/src/__tests__/golden-replay.test.ts",
        "-t",
        "Golden: feedback-loop",
      ],
      cwd: "/repo",
    });
    expect(removeBunfig).toHaveBeenCalledWith("/tmp/koi-runtime-golden-replay/bunfig.toml");
  });

  test("removes the bunfig even if command execution throws", () => {
    const removeBunfig = mock(() => {});

    expect(() =>
      runRuntimeGoldenReplay(
        [],
        "/repo",
        () => "/tmp/koi-runtime-golden-replay/bunfig.toml",
        removeBunfig,
        () => {
          throw new Error("boom");
        },
      ),
    ).toThrow("boom");

    expect(removeBunfig).toHaveBeenCalledWith("/tmp/koi-runtime-golden-replay/bunfig.toml");
  });

  test("uses the default cleanup to remove the bunfig dir when no override is provided", () => {
    const bunfigPath = createNoCoverageBunfig();
    const bunfigDir = dirname(bunfigPath);

    runRuntimeGoldenReplay(
      [],
      "/repo",
      () => bunfigPath,
      undefined,
      () => ({ exitCode: 0 }),
    );

    expect(existsSync(bunfigDir)).toBe(false);
  });

  test("--config path resolves to the temp bunfig under the repo root", () => {
    const seen: CommandSpec[] = [];

    runRuntimeGoldenReplay(
      [],
      "/repo",
      () => "/tmp/koi-runtime-golden-replay/bunfig.toml",
      () => {},
      (command) => {
        seen.push(command);
        return { exitCode: 0 };
      },
    );

    const testCommand = seen[1];
    if (!testCommand) throw new Error("expected a second spawn call");
    expect(testCommand.cwd).toBe("/repo");
    expect(testCommand.cmd).toContain("--config=/tmp/koi-runtime-golden-replay/bunfig.toml");
    expect(testCommand.cmd).toContain(
      join("/repo", "packages/meta/runtime/src/__tests__/golden-replay.test.ts"),
    );
  });
});
