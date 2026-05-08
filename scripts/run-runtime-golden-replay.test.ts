import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildCommands,
  type CommandSpec,
  createNoCoverageRunDir,
  runCommands,
  runRuntimeGoldenReplay,
  spawnCommand,
} from "./run-runtime-golden-replay.ts";

describe("createNoCoverageRunDir", () => {
  test("writes a local bunfig.toml that disables coverage", () => {
    const runDir = createNoCoverageRunDir();

    try {
      expect(existsSync(join(runDir, "bunfig.toml"))).toBe(true);
      expect(readFileSync(join(runDir, "bunfig.toml"), "utf8")).toContain("coverage = false");
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });
});

describe("buildCommands", () => {
  test("builds @koi/runtime before running golden-replay from a no-coverage cwd", () => {
    const repoRoot = resolve(process.cwd());
    const runDir = mkdtempSync(join(tmpdir(), "koi-runtime-golden-replay-test-"));

    try {
      const commands = buildCommands(repoRoot, runDir, []);

      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual({
        cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
        cwd: repoRoot,
      });
      expect(commands[1]).toEqual({
        cmd: [
          process.execPath,
          "test",
          join(repoRoot, "packages/meta/runtime/src/__tests__/golden-replay.test.ts"),
        ],
        cwd: runDir,
      });
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  test("forwards extra Bun test arguments to golden-replay", () => {
    const repoRoot = resolve(process.cwd());
    const runDir = mkdtempSync(join(tmpdir(), "koi-runtime-golden-replay-test-"));

    try {
      const commands = buildCommands(repoRoot, runDir, [
        "-t",
        "middleware-feedback-loop|middleware-semantic-retry",
      ]);

      expect(commands[1]).toEqual({
        cmd: [
          process.execPath,
          "test",
          join(repoRoot, "packages/meta/runtime/src/__tests__/golden-replay.test.ts"),
          "-t",
          "middleware-feedback-loop|middleware-semantic-retry",
        ],
        cwd: runDir,
      });
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });
});

describe("runCommands", () => {
  test("runs commands in order", () => {
    const seen: CommandSpec[] = [];

    runCommands(
      [
        { cmd: ["bun", "run", "build"], cwd: "/repo" },
        { cmd: ["bun", "test", "/repo/test.ts"], cwd: "/tmp/run" },
      ],
      (command) => {
        seen.push(command);
        return { exitCode: 0 };
      },
    );

    expect(seen).toEqual([
      { cmd: ["bun", "run", "build"], cwd: "/repo" },
      { cmd: ["bun", "test", "/repo/test.ts"], cwd: "/tmp/run" },
    ]);
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
  test("creates and removes a no-coverage run dir around the targeted commands", () => {
    const spawn = mock(() => ({ exitCode: 0 }));
    const createRunDir = mock(() => "/tmp/koi-runtime-golden-replay");
    const removeRunDir = mock(() => {});

    runRuntimeGoldenReplay(
      ["-t", "Golden: feedback-loop"],
      "/repo",
      createRunDir,
      removeRunDir,
      spawn,
    );

    expect(createRunDir).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenNthCalledWith(1, {
      cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
      cwd: "/repo",
    });
    expect(spawn).toHaveBeenNthCalledWith(2, {
      cmd: [
        process.execPath,
        "test",
        "/repo/packages/meta/runtime/src/__tests__/golden-replay.test.ts",
        "-t",
        "Golden: feedback-loop",
      ],
      cwd: "/tmp/koi-runtime-golden-replay",
    });
    expect(removeRunDir).toHaveBeenCalledWith("/tmp/koi-runtime-golden-replay");
  });

  test("removes the run dir even if command execution throws", () => {
    const removeRunDir = mock(() => {});

    expect(() =>
      runRuntimeGoldenReplay(
        [],
        "/repo",
        () => "/tmp/koi-runtime-golden-replay",
        removeRunDir,
        () => {
          throw new Error("boom");
        },
      ),
    ).toThrow("boom");

    expect(removeRunDir).toHaveBeenCalledWith("/tmp/koi-runtime-golden-replay");
  });

  test("uses the default run-dir cleanup when no override is provided", () => {
    const runDir = mkdtempSync(join(tmpdir(), "koi-runtime-golden-replay-default-"));

    runRuntimeGoldenReplay(
      [],
      "/repo",
      () => runDir,
      undefined,
      () => ({ exitCode: 0 }),
    );

    expect(existsSync(runDir)).toBe(false);
  });
});
