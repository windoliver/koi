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
  readonly exitCode: number | null;
  readonly signalCode?: string | null;
};

export type SpawnSync = (command: CommandSpec) => SpawnResult;

export function createNoCoverageBunfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "koi-runtime-golden-replay-"));
  const bunfigPath = join(dir, "bunfig.toml");
  writeFileSync(bunfigPath, NO_COVERAGE_BUNFIG);
  return bunfigPath;
}

export function buildCommands(
  repoRoot: string,
  bunfigPath: string,
  extraArgs: readonly string[],
): readonly CommandSpec[] {
  return [
    {
      cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
      cwd: repoRoot,
    },
    {
      cmd: [
        process.execPath,
        `--config=${bunfigPath}`,
        "test",
        join(repoRoot, GOLDEN_REPLAY_PATH),
        ...extraArgs,
      ],
      cwd: repoRoot,
    },
  ];
}

export function spawnCommand(command: CommandSpec): SpawnResult {
  const result = Bun.spawnSync({
    cmd: [...command.cmd],
    cwd: command.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { exitCode: result.exitCode, signalCode: result.signalCode ?? null };
}

export function resolveExitStatus(result: SpawnResult): number {
  if (result.signalCode != null) {
    return 128;
  }
  if (result.exitCode == null) {
    return 1;
  }
  return result.exitCode;
}

export function runCommands(
  commands: readonly CommandSpec[],
  spawn: SpawnSync = spawnCommand,
): void {
  for (const command of commands) {
    const result = spawn(command);
    const status = resolveExitStatus(result);
    if (status !== 0) {
      process.exit(status);
    }
  }
}

export function runRuntimeGoldenReplay(
  extraArgs: readonly string[],
  repoRoot: string = resolve(process.cwd()),
  createBunfig: () => string = createNoCoverageBunfig,
  removeBunfig: (bunfigPath: string) => void = (bunfigPath: string): void => {
    rmSync(join(bunfigPath, ".."), { force: true, recursive: true });
  },
  spawn: SpawnSync = spawnCommand,
): void {
  const bunfigPath = createBunfig();

  try {
    runCommands(buildCommands(repoRoot, bunfigPath, extraArgs), spawn);
  } finally {
    removeBunfig(bunfigPath);
  }
}

if (import.meta.main) {
  runRuntimeGoldenReplay(process.argv.slice(2));
}
