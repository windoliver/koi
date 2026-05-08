import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GOLDEN_REPLAY_PATH = "packages/meta/runtime/src/__tests__/golden-replay.test.ts";
const NO_COVERAGE_BUNFIG = `[test]
coverage = false
`;

export type CommandSpec = {
  readonly cmd: readonly string[];
  readonly cwd: string;
};

export type SpawnResult = {
  readonly exitCode: number;
};

export type SpawnSync = (command: CommandSpec) => SpawnResult;

export function createNoCoverageRunDir(): string {
  const runDir = mkdtempSync(join(tmpdir(), "koi-runtime-golden-replay-"));
  writeFileSync(join(runDir, "bunfig.toml"), NO_COVERAGE_BUNFIG);
  writeFileSync(join(runDir, ".gitignore"), "*\n");
  return runDir;
}

export function buildCommands(
  repoRoot: string,
  runDir: string,
  extraArgs: readonly string[],
): readonly CommandSpec[] {
  return [
    {
      cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
      cwd: repoRoot,
    },
    {
      cmd: [process.execPath, "test", join(repoRoot, GOLDEN_REPLAY_PATH), ...extraArgs],
      cwd: runDir,
    },
  ];
}

export function spawnCommand(command: CommandSpec): SpawnResult {
  return Bun.spawnSync({
    cmd: [...command.cmd],
    cwd: command.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

export function runCommands(
  commands: readonly CommandSpec[],
  spawn: SpawnSync = spawnCommand,
): void {
  for (const command of commands) {
    const result = spawn(command);
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  }
}

export function runRuntimeGoldenReplay(
  extraArgs: readonly string[],
  repoRoot = resolve(process.cwd()),
  createRunDir: () => string = createNoCoverageRunDir,
  removeRunDir: (runDir: string) => void = (runDir) =>
    rmSync(runDir, { force: true, recursive: true }),
  spawn: SpawnSync = spawnCommand,
): void {
  const runDir = createRunDir();

  try {
    runCommands(buildCommands(repoRoot, runDir, extraArgs), spawn);
  } finally {
    removeRunDir(runDir);
  }
}

if (import.meta.main) {
  runRuntimeGoldenReplay(process.argv.slice(2));
}
