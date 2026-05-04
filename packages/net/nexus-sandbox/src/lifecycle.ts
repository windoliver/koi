/**
 * Spawn / shutdown lifecycle for the nexus-ai-fs[sandbox] subprocess.
 *
 * `startSandbox` resolves argv, builds env, spawns, races health-poll
 * against early exit, and returns either a `SandboxHandle` or a typed
 * `KoiError`. `stopSandbox` sends SIGTERM, waits up to `drainMs`, then
 * SIGKILLs.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { resolveCommand } from "./binary-resolver.js";
import { portInUseError, shutdownTimeoutError, spawnFailedError } from "./errors.js";
import { pollHealth } from "./health-check.js";
import type { SandboxConfig, SandboxHandle, SpawnFn, SpawnOptions, StopOptions } from "./types.js";

const DEFAULT_PORT = 2026;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DATA_DIR = join(homedir(), ".nexus", "sandbox");
const DEFAULT_DRAIN_MS = 5000;
const PORT_LOCK_DIR = join(homedir(), ".nexus", "sandbox-locks");
// Yield after health-200 to let a losing concurrent child surface EADDRINUSE
// on its own exit. Defense in depth alongside the per-port advisory lock.
const POST_HEALTH_GRACE_MS = 50;
// Margin past the owner's healthTimeoutMs before a peer treats the lock as
// stale. Covers post-health drain + handoff slop.
const STARTUP_GRACE_MS = 30_000;
// Default healthTimeoutMs (mirrors health-check.DEFAULT_TOTAL_TIMEOUT_MS).
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
// Reclaim sentinel auto-recovery window: an in-progress takeover should
// take milliseconds; anything older than this is presumed wedged.
const RECLAIM_LOCK_TTL_MS = 5_000;

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
  // lock; the loser bails with CONFLICT instead of racing to bind and
  // accepting a stranger's /health response. Skipped under injected `spawn`
  // (mock tests don't bind a real port). Released by `stopSandbox` after
  // drain, so the slot stays reserved for THIS sandbox's lifetime.
  let releasePortLock: (() => void) | undefined;
  if (config.spawn === undefined) {
    // Stale-lock threshold tracks THIS caller's configured startup deadline:
    // a slow contributor-mode `uv run nexusd` with `healthTimeoutMs: 180_000`
    // must not be reclaimable as stale until well past 180s. The lock file
    // also embeds its own deadline so a peer reader uses the OWNER's deadline
    // (line 286) — this margin is just our local fallback.
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
    // Health probe timed out. Drain the orphan via the full stopSandbox path
    // (SIGTERM → wait drainMs → SIGKILL) so the half-spawned child cannot
    // outlive its parent CLI on a slow-start failure. Bare SIGTERM here would
    // leave a wedged subprocess pinning the port for the next attempt.
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

  // Defense in depth: the advisory lock keeps concurrent startSandbox()
  // callers from racing each other, but a non-locking peer (foreign tool,
  // stale daemon that started after our pre-spawn probe) can still win the
  // bind race. Two layers of post-health validation:
  //   1. Confirm OUR child has not exited (cheap, always runs).
  //   2. When `lsof` is available, confirm our pid is the listener on port
  //      — deterministic ownership proof without nexusd cooperation.
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
    return {
      ok: false,
      error: spawnFailedError({ exitCode: exitedAfterHealth.code, stderr }),
    };
  }
  // Listener-ownership verification only runs on the real spawn path. Tests
  // that inject `spawn` use a synthetic pid that obviously doesn't appear in
  // the host's lsof output, so skip there to avoid false negatives.
  if (proc.pid !== undefined && (config.spawn === undefined || config.verifyListenerOwnership)) {
    const verify = config.verifyListenerOwnership ?? defaultVerifyListenerOwnership;
    const owned = await verify(proc.pid, port);
    if (owned === false) {
      // Foreign listener occupies the port; OUR child either lost the bind
      // race or is bound to something else. Drain via stopSandbox so the
      // half-spawned child cannot outlive its parent CLI.
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
    // owned === undefined → verifier could not run (no lsof); already gated
    // by lock + probe + child-exit settle, accept best-effort.
  }

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

export async function stopSandbox(
  handle: SandboxHandle,
  opts: StopOptions = {},
): Promise<Result<void, KoiError>> {
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  // Snapshot descendants BEFORE signalling: the actual nexusd listener is
  // typically a child of `uvx`/`uv run`, and a wrapper that exits cleanly
  // without forwarding SIGTERM can orphan the listener under init while we
  // happily release the port lock. By collecting the tree up front we can
  // signal/sweep descendants ourselves regardless of wrapper behavior.
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
  // before we release the lock. This enforces "lock release implies the
  // listener is gone" — otherwise a re-spawn against the same port could
  // race a still-running nexusd that survived its wrapper.
  const stillAlive = descendants.filter(isPidAlive);
  for (const child of stillAlive) {
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
  // SIGKILL is unblockable; release the lock so the next start can claim the
  // slot once the kernel finishes reaping. Skipping this on the timeout path
  // would leak a stale lock file across CLI invocations.
  handle._releasePortLock?.();
  const pid = handle.pid ?? -1;
  return { ok: false, error: shutdownTimeoutError(pid, drainMs) };
}

async function snapshotDescendants(rootPid: number): Promise<readonly number[]> {
  if (Bun.which("pgrep") === null) return [];
  const all: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const children = await getDirectChildren(current);
    for (const child of children) {
      if (!seen.has(child)) {
        all.push(child);
        queue.push(child);
      }
    }
  }
  return all;
}

async function getDirectChildren(pid: number): Promise<readonly number[]> {
  try {
    const proc = Bun.spawn(["pgrep", "-P", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 1);
  } catch {
    return [];
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
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
  // Strip every inherited NEXUS_* key so a stray parent-shell value (e.g.
  // a developer who exported NEXUS_DATA_DIR or NEXUS_ENABLE_VECTOR_SEARCH
  // for an earlier session) cannot silently override the deterministic
  // CLI flags + the explicit fields configured here.
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

/**
 * Acquire an OS-level advisory lock keyed by host:port for the sandbox
 * lifetime. Stale locks are reclaimed only when (a) the caller's port probe
 * said the port is free AND (b) the lock file's mtime is older than the
 * startup window — combining both conditions prevents a concurrent starter
 * from unlinking a freshly-acquired lock during the small window between
 * lock creation and the bind. Time-based reclaim sidesteps PID-reuse
 * hazards in liveness checks.
 */
function acquirePortLock(
  host: string,
  port: number,
  portIsFree: boolean,
  stalenessMs: number,
): { readonly release: () => void } | null {
  const lockPath = join(PORT_LOCK_DIR, `${host}-${String(port)}.lock`);
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // mkdirSync can fail on read-only filesystems / permission errors; in
    // that case fall through and let openSync surface the underlying error.
  }
  const fd = tryCreateLockFile(lockPath, stalenessMs);
  if (fd === null) {
    if (portIsFree && lockIsStale(lockPath, stalenessMs)) {
      return reclaimStaleLock(lockPath, stalenessMs);
    }
    return null;
  }
  return makeLockHandle(fd, lockPath);
}

/**
 * Atomic stale-lock takeover. Two callers passing `lockIsStale()` cannot
 * both unlink-and-recreate: a per-lock "reclaim" sentinel serializes the
 * critical section, the staleness check is repeated UNDER the sentinel
 * (so a parallel reclaim that already swapped the lock is observed), and
 * recovery is bounded — a wedged reclaim sentinel older than RECLAIM_LOCK_TTL
 * is itself reclaimable, preventing a permanent deadlock if a reclaimer
 * crashes mid-takeover.
 */
function reclaimStaleLock(
  lockPath: string,
  stalenessMs: number,
): { readonly release: () => void } | null {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd: number | null = null;
  try {
    reclaimFd = openSync(reclaimPath, "wx");
  } catch {
    // Reclaim sentinel exists; bail unless it's ancient (wedged reclaimer).
    try {
      const st = statSync(reclaimPath);
      if (Date.now() - st.mtimeMs < RECLAIM_LOCK_TTL_MS) return null;
      try {
        unlinkSync(reclaimPath);
      } catch {
        return null;
      }
      reclaimFd = openSync(reclaimPath, "wx");
    } catch {
      return null;
    }
  }
  try {
    // Re-check under the reclaim sentinel. A concurrent reclaimer that beat
    // us into the critical section may have already swapped the lock for a
    // fresh one; in that case lockIsStale returns false and we conflict.
    if (!lockIsStale(lockPath, stalenessMs)) return null;
    try {
      unlinkSync(lockPath);
    } catch {
      /* concurrent reclaim; fall through */
    }
    const fresh = tryCreateLockFile(lockPath, stalenessMs);
    if (fresh === null) return null;
    return makeLockHandle(fresh, lockPath);
  } finally {
    if (reclaimFd !== null) {
      try {
        closeSync(reclaimFd);
      } catch {
        /* fd already closed */
      }
    }
    try {
      unlinkSync(reclaimPath);
    } catch {
      /* sentinel already cleaned up */
    }
  }
}

/**
 * Lock file format: `pid\tlocked_at_iso\tdeadline_ms_epoch\n`
 * The deadline is OWNER-supplied, so a peer reader honors the owner's
 * configured startup window even under heterogeneous healthTimeoutMs. Falls
 * back to the peer's own staleness window if the file is unparseable.
 */
function lockIsStale(lockPath: string, fallbackStalenessMs: number): boolean {
  try {
    const text = readFileSync(lockPath, "utf-8");
    const parts = text.trim().split("\t");
    const deadline = parts.length >= 3 ? Number.parseInt(parts[2] ?? "", 10) : Number.NaN;
    if (Number.isFinite(deadline)) return Date.now() > deadline;
    // Unparseable owner metadata — fall back to peer-supplied window vs mtime.
    const st = statSync(lockPath);
    return Date.now() - st.mtimeMs > fallbackStalenessMs;
  } catch {
    // statSync/read failure on a path we just observed via openSync's EEXIST
    // is an FS race (concurrent unlink). Treat as not-stale so we don't try
    // to reclaim what someone else may have already taken.
    return false;
  }
}

function tryCreateLockFile(lockPath: string, stalenessMs: number): number | null {
  try {
    // O_CREAT | O_EXCL | O_WRONLY — succeeds only when the file does NOT
    // exist, which is the atomic primitive we need across concurrent callers.
    const fd = openSync(lockPath, "wx");
    const deadlineMs = Date.now() + stalenessMs;
    try {
      // pid and acquire-time as breadcrumbs; deadline drives stale recovery.
      // The owner records its OWN deadline so concurrent peers honor the
      // owner's configured startup window, not their own narrower one.
      writeSync(fd, `${String(process.pid)}\t${new Date().toISOString()}\t${String(deadlineMs)}\n`);
    } catch {
      /* best-effort metadata; the file's existence is the lock */
    }
    return fd;
  } catch {
    return null;
  }
}

function makeLockHandle(fd: number, lockPath: string): { readonly release: () => void } {
  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        /* fd already closed */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* unlink-after-close is racy on some FS; tolerate */
      }
    },
  };
}

/**
 * Decide whether `pid` (or any of its descendants) is listening on `port`.
 * Walks the parent chain because the default launch path is a wrapper:
 * `uvx --from nexus-ai-fs nexusd` — the actual listener is nexusd, a child
 * of the uvx process Bun.spawn returned. Returns:
 *   - `true`      → confirmed: our process tree owns the listener (proceed)
 *   - `false`     → confirmed: listener belongs to a different process tree,
 *                   OR no listener despite prior /health 200 (reject)
 *   - `undefined` → required tools (lsof or ps) genuinely unavailable;
 *                   caller falls through to weaker defenses (lock + probe
 *                   + child-exit settle). Platforms without these are
 *                   treated as "verification not supported" rather than
 *                   fail-closed so local-dev on those systems still works.
 */
const defaultVerifyListenerOwnership = async (
  pid: number,
  port: number,
): Promise<boolean | undefined> => {
  if (Bun.which("lsof") === null) return undefined;
  if (Bun.which("ps") === null) return undefined;
  let listenerPids: readonly number[];
  try {
    const proc = Bun.spawn(
      ["lsof", "-i", `tcp:${String(port)}`, "-sTCP:LISTEN", "-P", "-n", "-t"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0 && exitCode !== 1) return false;
    listenerPids = text
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return false;
  }
  if (listenerPids.length === 0) return false;
  for (const candidate of listenerPids) {
    if (await isDescendantOrSelf(candidate, pid)) return true;
  }
  return false;
};

async function isDescendantOrSelf(candidatePid: number, ancestorPid: number): Promise<boolean> {
  if (candidatePid === ancestorPid) return true;
  // Walk parent chain. Cap at 16 hops — typical wrapper depth is 1-2; a
  // pathological chain longer than 16 likely means we crossed a session
  // boundary and the sandbox is not ours regardless.
  let current = candidatePid;
  for (let depth = 0; depth < 16; depth++) {
    const ppid = await getParentPid(current);
    if (ppid === undefined) return false;
    if (ppid === ancestorPid) return true;
    if (ppid <= 1) return false;
    current = ppid;
  }
  return false;
}

async function getParentPid(pid: number): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(["ps", "-o", "ppid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const ppid = Number.parseInt(text.trim(), 10);
    return Number.isFinite(ppid) && ppid >= 0 ? ppid : undefined;
  } catch {
    return undefined;
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
