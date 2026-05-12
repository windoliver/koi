import { describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";

import {
  buildCommands,
  type CommandSpec,
  createNoCoverageBunfig,
  defaultRepoRoot,
  resolveExitStatus,
  runCommands,
  runRuntimeGoldenReplay,
  signalExitCode,
  spawnCommand,
} from "./run-runtime-golden-replay.js";

describe("defaultRepoRoot", () => {
  test("resolves to the repo root from the script location, independent of cwd", () => {
    const repoRoot = defaultRepoRoot();

    expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "scripts", "run-runtime-golden-replay.ts"))).toBe(true);
    expect(
      existsSync(join(repoRoot, "packages/meta/runtime/src/__tests__/golden-replay.test.ts")),
    ).toBe(true);
  });

  test("returns the same path regardless of process.cwd()", () => {
    const fromHere = defaultRepoRoot();
    const originalCwd = process.cwd();
    try {
      process.chdir(dirname(originalCwd));
      expect(defaultRepoRoot()).toBe(fromHere);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

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

describe("signalExitCode", () => {
  test("returns 128 + signo for known POSIX signals (SIGINT -> 130, SIGTERM -> 143)", () => {
    const signals = osConstants.signals as unknown as Record<string, number | undefined>;
    const sigint = signals.SIGINT ?? 0;
    const sigterm = signals.SIGTERM ?? 0;
    expect(signalExitCode("SIGINT")).toBe(128 + sigint);
    expect(signalExitCode("SIGTERM")).toBe(128 + sigterm);
  });

  test("distinguishes SIGINT from SIGTERM", () => {
    expect(signalExitCode("SIGINT")).not.toBe(signalExitCode("SIGTERM"));
  });

  test("falls back to 128 when the signal name is unknown", () => {
    expect(signalExitCode("SIGNOPE_NOT_REAL")).toBe(128);
  });
});

describe("resolveExitStatus", () => {
  test("returns the child's exit code on a normal exit", () => {
    expect(resolveExitStatus({ exitCode: 0 })).toBe(0);
    expect(resolveExitStatus({ exitCode: 2 })).toBe(2);
  });

  test("maps signaled children to 128 + signo (SIGTERM -> 143)", () => {
    const signals = osConstants.signals as unknown as Record<string, number | undefined>;
    const sigterm = signals.SIGTERM ?? 0;
    expect(resolveExitStatus({ exitCode: null, signalCode: "SIGTERM" })).toBe(128 + sigterm);
  });

  test("returns 1 when the child has neither a code nor a signal", () => {
    expect(resolveExitStatus({ exitCode: null })).toBe(1);
    expect(resolveExitStatus({ exitCode: null, signalCode: null })).toBe(1);
  });
});

describe("runCommands", () => {
  test("runs commands in order and returns 0 when all succeed", () => {
    const seen: CommandSpec[] = [];

    const status = runCommands(
      [
        { cmd: ["bun", "run", "build"], cwd: "/repo" },
        { cmd: ["bun", "test", "/repo/test.ts"], cwd: "/repo" },
      ],
      (command) => {
        seen.push(command);
        return { exitCode: 0 };
      },
    );

    expect(status).toBe(0);
    expect(seen).toHaveLength(2);
  });

  test("returns the failing exit code and stops at the first failure", () => {
    const seen: CommandSpec[] = [];
    const status = runCommands(
      [
        { cmd: ["bun", "run", "build"], cwd: "/repo" },
        { cmd: ["bun", "test"], cwd: "/repo" },
      ],
      (command) => {
        seen.push(command);
        return { exitCode: command.cmd[1] === "run" ? 0 : 7 };
      },
    );

    expect(status).toBe(7);
    expect(seen).toHaveLength(2);
  });

  test("returns 128 + signo when a child is killed by signal", () => {
    const signals = osConstants.signals as unknown as Record<string, number | undefined>;
    const sigterm = signals.SIGTERM ?? 0;
    const status = runCommands([{ cmd: ["bun", "test"], cwd: "/repo" }], () => ({
      exitCode: null,
      signalCode: "SIGTERM",
    }));

    expect(status).toBe(128 + sigterm);
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
  test("returns 0 and runs build + golden-replay with the supplied repo root", () => {
    const spawn = mock(() => ({ exitCode: 0 }));
    const createBunfig = mock(() => "/tmp/koi-runtime-golden-replay/bunfig.toml");
    const removeBunfig = mock(() => {});

    const status = runRuntimeGoldenReplay(
      ["-t", "Golden: feedback-loop"],
      "/repo",
      createBunfig,
      removeBunfig,
      spawn,
    );

    expect(status).toBe(0);
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

  test("returns the failing status and still removes the bunfig on a non-zero child exit", () => {
    const removeBunfig = mock(() => {});

    const status = runRuntimeGoldenReplay(
      [],
      "/repo",
      () => "/tmp/koi-runtime-golden-replay/bunfig.toml",
      removeBunfig,
      () => ({ exitCode: 5 }),
    );

    expect(status).toBe(5);
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

  test("default cleanup removes the temp bunfig dir on failure (no leak)", () => {
    const bunfigPath = createNoCoverageBunfig();
    const bunfigDir = dirname(bunfigPath);

    const status = runRuntimeGoldenReplay(
      [],
      "/repo",
      () => bunfigPath,
      undefined,
      () => ({ exitCode: 9 }),
    );

    expect(status).toBe(9);
    expect(existsSync(bunfigDir)).toBe(false);
  });

  test("default cleanup removes the temp bunfig dir on success", () => {
    const bunfigPath = createNoCoverageBunfig();
    const bunfigDir = dirname(bunfigPath);

    const status = runRuntimeGoldenReplay(
      [],
      "/repo",
      () => bunfigPath,
      undefined,
      () => ({ exitCode: 0 }),
    );

    expect(status).toBe(0);
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
