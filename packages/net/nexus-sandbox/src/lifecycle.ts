/**
 * Spawn / shutdown lifecycle for the nexus-ai-fs[sandbox] subprocess.
 *
 * `startSandbox` resolves argv, builds env, spawns, races health-poll
 * against early exit, and returns either a `SandboxHandle` or a typed
 * `KoiError`. `stopSandbox` sends SIGTERM, waits up to `drainMs`, then
 * SIGKILLs.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { resolveCommand } from "./binary-resolver.js";
import { portInUseError, shutdownTimeoutError, spawnFailedError } from "./errors.js";
import { pollHealth } from "./health-check.js";
import type { SandboxConfig, SandboxHandle, SpawnFn, SpawnOptions, StopOptions } from "./types.js";

const DEFAULT_PORT = 2026;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DATA_DIR = join(homedir(), ".nexus", "sandbox");
const DEFAULT_DRAIN_MS = 5000;

const PORT_IN_USE_PATTERNS = [
  /address already in use/i,
  /errno\s*48/i,
  /errno\s*98/i,
  /eaddrinuse/i,
];

export async function startSandbox(
  config: SandboxConfig = {},
): Promise<Result<SandboxHandle, KoiError>> {
  const port = config.port ?? DEFAULT_PORT;
  const host = config.host ?? DEFAULT_HOST;
  const dataDir = config.dataDir ?? DEFAULT_DATA_DIR;
  const baseUrl = `http://${host}:${String(port)}`;
  const argv = [
    ...resolveCommand({ command: config.command, sourceDir: config.sourceDir }),
    "serve",
  ];
  const env = buildEnv({
    port,
    host,
    dataDir,
    enableVectorSearch: config.enableVectorSearch === true,
    embeddingModel: config.embeddingModel,
  });

  const spawn: SpawnFn = config.spawn ?? defaultSpawn;
  const spawnResult = trySpawn(spawn, argv, env);
  if (!spawnResult.ok) return spawnResult;
  const proc = spawnResult.value;

  const stderrPromise = readAll(proc.stderr);
  const healthPromise = pollHealth(baseUrl, config.fetch, config.healthTimeoutMs);
  const exitPromise = proc.exited.then((code) => ({ kind: "exit" as const, code }));

  const winner = await Promise.race([
    healthPromise.then((r) => ({ kind: "health" as const, result: r })),
    exitPromise,
  ]);

  if (winner.kind === "exit") {
    const stderr = await stderrPromise;
    if (PORT_IN_USE_PATTERNS.some((re) => re.test(stderr))) {
      return { ok: false, error: portInUseError(port) };
    }
    return { ok: false, error: spawnFailedError({ exitCode: winner.code, stderr }) };
  }

  if (!winner.result.ok) {
    proc.kill("SIGTERM");
    return { ok: false, error: winner.result.error };
  }

  return {
    ok: true,
    value: { baseUrl, pid: proc.pid, dataDir, _process: proc },
  };
}

export async function stopSandbox(
  handle: SandboxHandle,
  opts: StopOptions = {},
): Promise<Result<void, KoiError>> {
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  handle._process.kill("SIGTERM");
  const drained = await Promise.race([
    handle._process.exited.then(() => true as const),
    Bun.sleep(drainMs).then(() => false as const),
  ]);
  if (drained) return { ok: true, value: undefined };
  handle._process.kill("SIGKILL");
  const pid = handle.pid ?? -1;
  return { ok: false, error: shutdownTimeoutError(pid, drainMs) };
}

function trySpawn(
  spawn: SpawnFn,
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Result<ReturnType<SpawnFn>, KoiError> {
  try {
    return {
      ok: true,
      value: spawn(argv, {
        env,
        stdio: ["ignore", "ignore", "pipe"] satisfies SpawnOptions["stdio"],
      }),
    };
  } catch (err) {
    return { ok: false, error: spawnFailedError({ cause: err }) };
  }
}

interface BuildEnvInput {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly enableVectorSearch: boolean;
  readonly embeddingModel: string | undefined;
}

function buildEnv(input: BuildEnvInput): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {
    ...process.env,
    NEXUS_PROFILE: "sandbox",
    NEXUS_DATA_DIR: input.dataDir,
    NEXUS_HOST: input.host,
    NEXUS_PORT: String(input.port),
  };
  if (input.enableVectorSearch) base.NEXUS_ENABLE_VECTOR_SEARCH = "true";
  if (input.embeddingModel !== undefined) base.NEXUS_EMBEDDING_MODEL = input.embeddingModel;
  return base;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

const defaultSpawn: SpawnFn = (cmd, opts) => {
  const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
    stdout: "ignore",
    stderr: "pipe",
  };
  if (opts?.env !== undefined) {
    spawnOpts.env = opts.env as Record<string, string>;
  }
  if (opts?.cwd !== undefined) {
    spawnOpts.cwd = opts.cwd;
  }
  const proc = Bun.spawn([...cmd], spawnOpts);
  return {
    pid: proc.pid,
    exited: proc.exited,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    kill: (signal) => proc.kill(signal as number | undefined),
    unref: () => proc.unref(),
  };
};
