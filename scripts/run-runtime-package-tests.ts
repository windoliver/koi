#!/usr/bin/env bun
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CommandSpec = {
  readonly cmd: readonly string[];
  readonly cwd: string;
};

export type SpawnResult = {
  readonly exitCode: number | null;
  readonly signalCode?: string | null;
};

export type SpawnSync = (command: CommandSpec) => SpawnResult;

const DEFAULT_SIGNAL_EXIT_CODE = 128;

export function defaultRepoRoot(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "..");
}

export function defaultRuntimePackageDir(repoRoot: string = defaultRepoRoot()): string {
  return join(repoRoot, "packages/meta/runtime");
}

export function buildCommands(
  repoRoot: string,
  packageDir: string,
  extraArgs: readonly string[],
): readonly CommandSpec[] {
  return [
    {
      cmd: [process.execPath, "run", "build", "--filter=@koi/runtime"],
      cwd: repoRoot,
    },
    {
      cmd: [process.execPath, "test", ...extraArgs],
      cwd: packageDir,
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

export function signalExitCode(signalCode: string): number {
  const signo = osConstants.signals[signalCode as keyof typeof osConstants.signals];
  if (typeof signo === "number" && signo > 0) {
    return 128 + signo;
  }
  return DEFAULT_SIGNAL_EXIT_CODE;
}

export function resolveExitStatus(result: SpawnResult): number {
  if (result.signalCode != null) {
    return signalExitCode(result.signalCode);
  }
  if (result.exitCode == null) {
    return 1;
  }
  return result.exitCode;
}

export function runCommands(
  commands: readonly CommandSpec[],
  spawn: SpawnSync = spawnCommand,
): number {
  for (const command of commands) {
    const status = resolveExitStatus(spawn(command));
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

export function runRuntimePackageTests(
  extraArgs: readonly string[],
  repoRoot: string = defaultRepoRoot(),
  packageDir: string = defaultRuntimePackageDir(repoRoot),
  spawn: SpawnSync = spawnCommand,
): number {
  return runCommands(buildCommands(repoRoot, packageDir, extraArgs), spawn);
}

if (import.meta.main) {
  const status = runRuntimePackageTests(process.argv.slice(2));
  if (status !== 0) {
    process.exit(status);
  }
}
