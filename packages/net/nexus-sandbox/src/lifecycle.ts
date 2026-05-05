/**
 * Spawn / shutdown lifecycle for the nexus-ai-fs[sandbox] subprocess.
 *
 * `startSandbox` resolves argv, builds env, spawns, races health-poll
 * against early exit, and returns either a `SandboxHandle` or a typed
 * `KoiError`. `stopSandbox` sends SIGTERM, waits up to `drainMs`, then
 * SIGKILLs.
 */

import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { resolveCommand } from "./binary-resolver.js";
import { portInUseError, shutdownTimeoutError, spawnFailedError } from "./errors.js";
import { pollHealth } from "./health-check.js";
import { acquirePortLock } from "./port-lock.js";
import { defaultVerifyListenerOwnership, isPidAlive, snapshotDescendants } from "./process-tree.js";
import type { SandboxConfig, SandboxHandle, SpawnFn, SpawnOptions, StopOptions } from "./types.js";

const DEFAULT_PORT = 2026;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DATA_DIR = join(homedir(), ".nexus", "sandbox");
const DEFAULT_DRAIN_MS = 5000;
// Yield after health-200 to let a losing concurrent child surface EADDRINUSE
// on its own exit. Defense in depth alongside the per-port advisory lock.
const POST_HEALTH_GRACE_MS = 50;
// Margin past the owner's healthTimeoutMs before a peer treats the lock as
// stale. Covers post-health drain + handoff slop.
const STARTUP_GRACE_MS = 30_000;
// Default healthTimeoutMs (mirrors health-check.DEFAULT_TOTAL_TIMEOUT_MS).
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;

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
    "--profile",
    "sandbox",
    "--host",
    host,
    "--port",
    String(port),
    "--data-dir",
    dataDir,
  ];
  const env = buildEnv({
    enableVectorSearch: config.enableVectorSearch === true,
    embeddingModel: config.embeddingModel,
  });

  // Pre-flight: refuse to spawn against an occupied port. Without this guard
  // a stale Nexus already bound to `port` could satisfy the health probe
  // before our spawned child reports EADDRINUSE — the caller would then bind
  // to the stranger's data store. Skip the probe when the caller injects a
  // mock spawn (test-only) or supplies its own probe via config.probePort.
  let portIsFree = true;
  const probe = config.probePort ?? defaultProbePort;
  if (config.spawn === undefined) {
    const occupied = await probe(host, port);
    if (occupied) return { ok: false, error: portInUseError(port) };
    portIsFree = true;
  }

  // Atomic per-port advisory lock — closes the TOCTOU between the probe and
  // the spawn. Two concurrent startSandbox() callers cannot both hold the
  // lock; the loser bails with CONFLICT. Skipped under injected `spawn`
  // (mock tests don't bind a real port). Released by `stopSandbox` after
  // drain so the slot stays reserved for THIS sandbox's lifetime.
  let releasePortLock: (() => void) | undefined;
  if (config.spawn === undefined) {
    const healthTimeoutMs = config.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    const stalenessMs = healthTimeoutMs + STARTUP_GRACE_MS;
    const lock = acquirePortLock(host, port, portIsFree, stalenessMs);
    if (lock === null) return { ok: false, error: portInUseError(port) };
    releasePortLock = lock.release;
  }

  const spawn: SpawnFn = config.spawn ?? defaultSpawn;
  const spawnResult = trySpawn(spawn, argv, env);
  if (!spawnResult.ok) {
    releasePortLock?.();
    return spawnResult;
  }
  const proc = spawnResult.value;

  const stderrPromise = readAll(proc.stderr);
  const healthPromise = pollHealth(baseUrl, config.fetch, config.healthTimeoutMs);
  const exitPromise = proc.exited.then((code) => ({ kind: "exit" as const, code }));

  const winner = await Promise.race([
    healthPromise.then((r) => ({ kind: "health" as const, result: r })),
    exitPromise,
  ]);

  if (winner.kind === "exit") {
    releasePortLock?.();
    const stderr = await stderrPromise;
    if (PORT_IN_USE_PATTERNS.some((re) => re.test(stderr))) {
      return { ok: false, error: portInUseError(port) };
    }
    return { ok: false, error: spawnFailedError({ exitCode: winner.code, stderr }) };
  }

  if (!winner.result.ok) {
    // Health probe timed out. Drain via stopSandbox so the half-spawned
    // child cannot outlive its parent CLI on a slow-start failure.
    const orphanHandle: SandboxHandle = {
      baseUrl,
      pid: proc.pid,
      dataDir,
      _process: proc,
      _releasePortLock: releasePortLock,
    };
    await stopSandbox(orphanHandle).catch(() => undefined);
    return { ok: false, error: winner.result.error };
  }

  const ownershipError = await verifyOwnershipAfterHealth({
    proc,
    port,
    baseUrl,
    dataDir,
    config,
    releasePortLock,
    stderrPromise,
  });
  if (ownershipError !== undefined) return ownershipError;

  return {
    ok: true,
    value: {
      baseUrl,
      pid: proc.pid,
      dataDir,
      _process: proc,
      _releasePortLock: releasePortLock,
    },
  };
}

interface OwnershipCheckInput {
  readonly proc: ReturnType<SpawnFn>;
  readonly port: number;
  readonly baseUrl: string;
  readonly dataDir: string;
  readonly config: SandboxConfig;
  readonly releasePortLock: (() => void) | undefined;
  readonly stderrPromise: Promise<string>;
}

/**
 * Two layers of post-health validation:
 *   1. Confirm OUR child has not exited (cheap, always runs).
 *   2. When `lsof` is available, confirm our pid (or a descendant) owns the
 *      listener — deterministic ownership without nexusd cooperation.
 * Returns a `Result` error variant when validation fails; `undefined` means
 * the handle is safe to return.
 */
async function verifyOwnershipAfterHealth(
  input: OwnershipCheckInput,
): Promise<Result<SandboxHandle, KoiError> | undefined> {
  const { proc, port, baseUrl, dataDir, config, releasePortLock, stderrPromise } = input;
  await Bun.sleep(POST_HEALTH_GRACE_MS);
  const exitedAfterHealth = await Promise.race([
    proc.exited.then((code) => ({ exited: true as const, code })),
    new Promise<{ exited: false }>((r) => setTimeout(() => r({ exited: false } as const), 0)),
  ]);
  if (exitedAfterHealth.exited) {
    releasePortLock?.();
    const stderr = await stderrPromise;
    if (PORT_IN_USE_PATTERNS.some((re) => re.test(stderr))) {
      return { ok: false, error: portInUseError(port) };
    }
    return { ok: false, error: spawnFailedError({ exitCode: exitedAfterHealth.code, stderr }) };
  }
  // Listener-ownership verification only runs on the real spawn path. Mock
  // tests use synthetic pids that obviously don't appear in the host's lsof.
  if (proc.pid !== undefined && (config.spawn === undefined || config.verifyListenerOwnership)) {
    const verify = config.verifyListenerOwnership ?? defaultVerifyListenerOwnership;
    const owned = await verify(proc.pid, port);
    if (owned === false) {
      const orphan: SandboxHandle = {
        baseUrl,
        pid: proc.pid,
        dataDir,
        _process: proc,
        _releasePortLock: releasePortLock,
      };
      await stopSandbox(orphan).catch(() => undefined);
      return { ok: false, error: portInUseError(port) };
    }
  }
  return undefined;
}

export async function stopSandbox(
  handle: SandboxHandle,
  opts: StopOptions = {},
): Promise<Result<void, KoiError>> {
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  // Snapshot descendants BEFORE signalling: the actual nexusd listener is
  // typically a child of `uvx`/`uv run`, and a wrapper that exits cleanly
  // without forwarding SIGTERM can orphan the listener under init while we
  // happily release the port lock.
  const rootPid = handle.pid;
  const descendants = rootPid !== undefined ? await snapshotDescendants(rootPid) : [];
  handle._process.kill("SIGTERM");
  for (const child of descendants) {
    try {
      process.kill(child, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  const drained = await Promise.race([
    handle._process.exited.then(() => true as const),
    Bun.sleep(drainMs).then(() => false as const),
  ]);
  // After the wrapper drain window, SIGKILL any descendant still alive
  // before we release the lock. Enforces "lock release implies the listener
  // is gone" — otherwise a re-spawn could race a still-running nexusd.
  for (const child of descendants.filter(isPidAlive)) {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      /* race with reaper */
    }
  }
  if (drained) {
    handle._releasePortLock?.();
    return { ok: true, value: undefined };
  }
  handle._process.kill("SIGKILL");
  handle._releasePortLock?.();
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
  readonly enableVectorSearch: boolean;
  readonly embeddingModel: string | undefined;
}

function buildEnv(input: BuildEnvInput): Record<string, string | undefined> {
  // Strip every inherited NEXUS_* key so a stray parent-shell value (e.g. a
  // developer who exported NEXUS_DATA_DIR or NEXUS_ENABLE_VECTOR_SEARCH for
  // an earlier session) cannot silently override the deterministic CLI flags
  // + the explicit fields configured here.
  const base: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("NEXUS_")) base[key] = value;
  }
  // Vector search is OFF unless the caller explicitly opts in. Always emit
  // the variable so an inherited "true" can never leak through even if a
  // future sanitizer skips an entry.
  base.NEXUS_ENABLE_VECTOR_SEARCH = input.enableVectorSearch ? "true" : "false";
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

const defaultProbePort = (host: string, port: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      // EADDRINUSE / EACCES → port unavailable; surface as occupied.
      resolve(code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL");
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(false));
    });
  });

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
