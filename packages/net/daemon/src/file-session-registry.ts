/**
 * File-backed implementation of `BackgroundSessionRegistry`. One JSON file
 * per session under `<dir>/<workerId>.json`. Atomic writes via tmp+rename so
 * concurrent readers never observe partial records.
 *
 * Cross-process queryable: CLI commands (`koi bg ps`, `koi bg kill`) run in
 * separate processes from the supervisor and read the registry directly from
 * disk. The supervisor owns writes; the CLI is read-only (except `kill`,
 * which updates status after signaling the PID).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type {
  BackgroundSessionEvent,
  BackgroundSessionRecord,
  BackgroundSessionRegistry,
  BackgroundSessionUpdate,
  KoiError,
  Result,
  WorkerId,
} from "@koi/core";
import { validateBackgroundSessionRecord } from "@koi/core";

/**
 * Allowed `workerId` shape for on-disk use. Restrictive by design: the id
 * becomes part of a filesystem path (`<dir>/<id>.json`, `<dir>/<id>.lock`)
 * and user-controlled input cannot be allowed to escape the registry root
 * via `..`, `/`, null bytes, or absolute paths. Keep in sync with any
 * upstream id producers (supervisor, CLI) — if a producer emits ids with
 * characters outside this set, register() will reject them.
 */
const WORKER_ID_SYNTAX = /^[A-Za-z0-9._-]+$/;

export interface FileSessionRegistryConfig {
  /** Directory where per-session JSON files live. Created if missing. */
  readonly dir: string;
}

/**
 * Richer read outcome exposed to operator commands (`koi bg ...`). The L0
 * `BackgroundSessionRegistry.get()` returns `undefined` for anything not
 * retrievable, which loses the distinction between genuinely-absent
 * records and on-disk corruption / permission errors. `describe()`
 * surfaces that distinction so the CLI can report actionable errors
 * instead of printing "No such session" for a permission-denied file.
 */
export interface FileSessionRegistry extends BackgroundSessionRegistry {
  readonly describe: (
    id: WorkerId,
  ) => Promise<Result<BackgroundSessionRecord | undefined, KoiError>>;
  /**
   * Result-based alternative to `list()` for operator commands. Returns
   * `INTERNAL` on filesystem faults (permission denied, mount errors)
   * instead of aliasing them to an empty array, so `koi bg ps` can
   * report "registry unavailable" rather than silently showing "no
   * background sessions" when the directory is broken. A genuinely
   * empty directory (ENOENT or no matching entries) still succeeds with
   * an empty array.
   */
  readonly describeList: () => Promise<Result<readonly BackgroundSessionRecord[], KoiError>>;
}

/**
 * Validate a `workerId` for filesystem safety. Callers should run this at
 * the L2 boundary; the registry also runs it as belt-and-suspenders.
 */
function checkWorkerIdSyntax(id: WorkerId): Result<void, KoiError> {
  if (!WORKER_ID_SYNTAX.test(String(id))) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `workerId ${JSON.stringify(String(id))} contains illegal characters; allowed: [A-Za-z0-9._-]`,
        retryable: false,
        context: { workerId: String(id) },
      },
    };
  }
  return { ok: true, value: undefined };
}

/**
 * How many times `update()` retries under concurrent-writer contention
 * before surfacing CONFLICT to the caller. Kept small — the registry is
 * not a hot row, so sustained conflict means something is wrong (stuck
 * writer, broken clock, caller bug) rather than healthy contention.
 */
const UPDATE_MAX_RETRIES = 5;

/**
 * How long we wait for a per-record lockfile before giving up. The
 * bridge's write path is low-latency (read → write tmp → rename), so
 * contention windows are small; anything exceeding the timeout suggests
 * a stuck writer and the caller should surface the error.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 3_000;

/**
 * Heuristic threshold for treating a lockfile as orphaned: if the
 * holder's recorded timestamp is older than this, we assume the writer
 * crashed and steal the lock. Generous enough that healthy holders
 * (which finish in milliseconds) never look stale.
 */
const LOCK_STALE_MS = 30_000;

/**
 * Poll interval while waiting for a contended lock. Short enough to
 * feel responsive for adjacent processes, long enough that a spinning
 * waiter doesn't burn measurable CPU.
 */
const LOCK_POLL_MS = 20;

/**
 * Create a file-backed registry. Callers must ensure only one registry
 * instance writes to `dir` at a time — there is no cross-process lock.
 */
export function createFileSessionRegistry(config: FileSessionRegistryConfig): FileSessionRegistry {
  const { dir } = config;
  // Absolute resolved registry root. Used to verify, on every fs path
  // construction, that the final path stays under this root even if
  // `checkWorkerIdSyntax` is somehow bypassed (defense in depth).
  const resolvedRoot = resolve(dir);
  const listeners = new Set<(event: BackgroundSessionEvent) => void>();
  // Per-workerId mutex: serialize in-process writes to the same record so
  // read-modify-rename cannot interleave against itself. This closes the
  // TOCTOU gap inside a single writer process. Cross-process concurrent
  // writers are still caught by the CAS check below, but for the common
  // case (supervisor bridge + local CLI) in-process ordering is enough.
  const writeChains = new Map<string, Promise<unknown>>();
  const serializeWrite = async <T>(id: WorkerId, fn: () => Promise<T>): Promise<T> => {
    const key = String(id);
    const prior = writeChains.get(key) ?? Promise.resolve();
    // The promise we track in the map MUST be the same reference the
    // cleanup callback compares against — otherwise `writeChains.get(key)`
    // always differs from the reference captured in the closure and keys
    // leak forever. Use a two-step declare/assign pattern so `chained`
    // resolves inside its own `finally`.
    let chained!: Promise<T>;
    chained = prior.then(fn, fn).finally(() => {
      if (writeChains.get(key) === chained) writeChains.delete(key);
    });
    writeChains.set(key, chained);
    return chained;
  };

  const ensureDir = async (): Promise<void> => {
    // 0o700 so registry metadata (command lines, pids) is owner-only
    // on shared hosts. `mkdir` ignores the mode when the dir already
    // exists, so operators can tighten existing perms separately.
    await mkdir(dir, { recursive: true, mode: 0o700 });
  };

  /**
   * Combined guard: syntactic validation PLUS canonical-path containment
   * under the registry root. Belt-and-suspenders — the regex alone
   * suffices for well-known path-traversal inputs, but the resolve-and-
   * compare catches platform quirks (e.g., trailing dots on Windows,
   * unicode normalization) that slip past pure regex checks. Every
   * public method invokes this before touching the filesystem.
   */
  const assertWorkerIdSafe = (id: WorkerId): Result<void, KoiError> => {
    const syntax = checkWorkerIdSyntax(id);
    if (!syntax.ok) return syntax;
    const candidate = resolve(join(resolvedRoot, `${id}.json`));
    const expected = join(resolvedRoot, `${id}.json`);
    if (candidate !== expected || !candidate.startsWith(`${resolvedRoot}${sep}`)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `workerId ${JSON.stringify(String(id))} resolves outside registry root`,
          retryable: false,
          context: { workerId: String(id) },
        },
      };
    }
    return { ok: true, value: undefined };
  };

  const recordPath = (id: WorkerId): string => join(dir, `${id}.json`);
  const lockPath = (id: WorkerId): string => join(dir, `${id}.lock`);

  /**
   * Sentinel thrown by acquireLock when the acquisition deadline expires.
   * Distinguished from generic errors so `underLock` can map it to
   * TIMEOUT and report other failures (permissions, missing directory,
   * etc.) as INTERNAL instead of misleading timeout telemetry.
   */
  class LockAcquireTimeout extends Error {
    constructor(id: WorkerId) {
      super(`timeout acquiring registry lock for ${id} after ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
      this.name = "LockAcquireTimeout";
    }
  }

  /**
   * Acquire a per-record lockfile. Ownership is established by a fresh
   * random token written into the lockfile. Stealing a stale lock uses
   * an atomic `rename()` to a stealer-unique name so exactly one
   * contender wins the steal; all others observe ENOENT on the rename
   * and retry acquisition from scratch. This closes the ABA race where
   * a stealer observes a stale lock, races a third-party acquisition,
   * and ends up deleting the new live lock.
   */
  const acquireLock = async (id: WorkerId): Promise<string> => {
    await ensureDir();
    const path = lockPath(id);
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    const token = randomBytes(16).toString("hex");
    while (true) {
      // Always enforce the deadline FIRST so pathological retry paths
      // (for example persistent EACCES on readFile below) cannot spin
      // forever — the earlier implementation short-circuited back to
      // the loop on any read/stat error and bypassed both the deadline
      // check and the poll sleep.
      if (Date.now() >= deadline) throw new LockAcquireTimeout(id);
      try {
        await writeFile(path, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return token;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw e;
        let staleMtime: number | undefined;
        try {
          staleMtime = (await stat(path)).mtimeMs;
        } catch (statErr) {
          const serr = statErr as NodeJS.ErrnoException;
          // ENOENT is the expected race (lock vanished between EEXIST
          // and stat) — retry with a brief sleep. Any other errno is a
          // real filesystem problem; surface it instead of spinning.
          if (serr.code === "ENOENT") {
            await Bun.sleep(LOCK_POLL_MS);
            continue;
          }
          throw statErr;
        }
        if (Date.now() - staleMtime > LOCK_STALE_MS) {
          // Stealing: rename the stale lock to a unique stealer-owned
          // name. rename is atomic — exactly one contender succeeds.
          // Losers see ENOENT and retry; the winner removes the
          // renamed file and loops back to acquire a fresh lock.
          const staleName = `${path}.stale-${token}`;
          try {
            await rename(path, staleName);
            await rm(staleName, { force: true }).catch(() => {});
          } catch (renameErr) {
            const rerr = renameErr as NodeJS.ErrnoException;
            if (rerr.code !== "ENOENT") throw renameErr;
            // Someone else stole first — retry without sleep penalty.
          }
          continue;
        }
        await Bun.sleep(LOCK_POLL_MS);
      }
    }
  };

  const releaseLock = async (id: WorkerId, ownerToken: string): Promise<void> => {
    // Only unlink if we still own the lock. If a stale-steal or operator
    // intervention replaced our lock, another holder's token is there —
    // we must not delete it.
    const path = lockPath(id);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === ownerToken) {
      await rm(path, { force: true }).catch(() => {});
    }
  };

  /**
   * Run `fn` under a per-record cross-process lockfile. Combined with the
   * in-process mutex above, this gives true mutual exclusion for
   * read-modify-write against any number of writer processes.
   *
   * The ownership token is threaded into `fn` so downstream writers
   * (notably `writeAtomicCas`) can verify at commit time that a stealer
   * hasn't taken the lock out from under a legitimate-but-slow holder.
   * Without that check, a slow writer whose lock was stolen via the
   * `LOCK_STALE_MS` policy would still be able to rename tmp→final and
   * silently clobber the stealer's write.
   */
  const underLock = async <T>(
    id: WorkerId,
    fn: (token: string) => Promise<Result<T, KoiError>>,
  ): Promise<Result<T, KoiError>> => {
    let token: string;
    try {
      token = await acquireLock(id);
    } catch (e) {
      if (e instanceof LockAcquireTimeout) {
        return {
          ok: false,
          error: {
            code: "TIMEOUT",
            message: e.message,
            retryable: true,
            context: { workerId: String(id) },
          },
        };
      }
      // Non-timeout failures — permissions, ENOSPC, broken path —
      // surface as INTERNAL so operators don't misread lock churn as
      // genuine deadlock.
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to acquire registry lock: ${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
          context: { workerId: String(id) },
        },
      };
    }
    try {
      return await fn(token);
    } finally {
      await releaseLock(id, token);
    }
  };

  /**
   * Verify that `ownerToken` still matches the current lockfile contents.
   * Used by commit paths as a belt-and-suspenders check — if a stealer
   * renamed our lockfile away while we were preparing the write, the
   * commit must abort rather than clobber the stealer's data.
   */
  const stillOwnsLock = async (id: WorkerId, ownerToken: string): Promise<boolean> => {
    const path = lockPath(id);
    try {
      const current = await readFile(path, "utf8");
      return current === ownerToken;
    } catch {
      return false;
    }
  };

  const emit = (event: BackgroundSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };

  /**
   * Compare-and-swap write: renames the tmp file onto the final path ONLY
   * if the currently-persisted version matches `expectedVersion`. On
   * mismatch, returns CONFLICT so the caller's retry loop can reload and
   * re-apply. Not perfectly airtight — a faster writer can still slip in
   * between the re-read and the rename — but the version field on every
   * record means subsequent observers will detect any lost write and
   * retry themselves.
   */
  const writeAtomicCas = async (
    id: WorkerId,
    record: BackgroundSessionRecord,
    expectedVersion: number,
    ownerToken: string,
  ): Promise<Result<void, KoiError>> => {
    await ensureDir();
    // Key the commit path off the caller-supplied `id`, NOT the
    // `record.workerId` payload field — that way a poisoned or
    // mismatched workerId inside the record payload can't redirect the
    // write to an arbitrary path. The readRecordDetailed identity check
    // already catches this case, but keeping writes keyed on the caller
    // `id` is defense in depth.
    const final = recordPath(id);
    const tmp = `${final}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
      // Re-read just before rename: any version drift means another
      // writer committed between our load and this check.
      const current = await readRecord(id);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        await rm(tmp, { force: true }).catch(() => {});
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Session ${id} version drift: expected ${expectedVersion}, found ${currentVersion}`,
            retryable: true,
            context: { workerId: String(id) },
          },
        };
      }
      // Ownership re-check immediately before the commit rename: if a
      // stealer took the lock out from under us (LOCK_STALE_MS policy),
      // abort rather than clobber the stealer's in-flight write. This
      // closes the window where a slow holder keeps rolling toward
      // commit while the lock has already been transferred.
      if (!(await stillOwnsLock(id, ownerToken))) {
        await rm(tmp, { force: true }).catch(() => {});
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Session ${id} lost lockfile ownership before commit (stolen as stale)`,
            retryable: true,
            context: { workerId: String(id) },
          },
        };
      }
      await rename(tmp, final);
      return { ok: true, value: undefined };
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to persist session record: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
          context: { workerId: String(id) },
        },
      };
    }
  };

  /**
   * Discriminated outcome of reading a record off disk. Separating
   * "genuinely missing" from "exists but unreadable/malformed" lets
   * `update()` surface storage faults as `INTERNAL` rather than aliasing
   * them to `NOT_FOUND`, which used to hide permission errors and
   * corrupt JSON behind a false "session doesn't exist" signal.
   */
  type ReadOutcome =
    | { readonly kind: "ok"; readonly record: BackgroundSessionRecord }
    | { readonly kind: "missing" }
    | { readonly kind: "corrupt"; readonly reason: string }
    | { readonly kind: "io-error"; readonly reason: string };

  const readRecordDetailed = async (id: WorkerId): Promise<ReadOutcome> => {
    const path = recordPath(id);
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // Bun.file(path).text() throws an ENOENT-flavored error for missing
      // files; treat that (and only that) as genuine absence.
      if (err.code === "ENOENT") return { kind: "missing" };
      return {
        kind: "io-error",
        reason: `read ${path}: ${err.message ?? String(e)}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return {
        kind: "corrupt",
        reason: `parse ${path}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!isRecord(parsed)) {
      return { kind: "corrupt", reason: `shape ${path}: record failed structural validation` };
    }
    // Identity invariant: the workerId inside the record MUST match the
    // filename key we read from. A mismatch means the record was either
    // tampered with (operator edit) or poisoned (attack) — in either
    // case we must NOT let update() proceed, because downstream code
    // treats `record.workerId` as authoritative and a rogue value
    // could redirect a later write to another session's path or break
    // the lockfile binding. Surface this as corruption, never as "ok".
    if (String(parsed.workerId) !== String(id)) {
      return {
        kind: "corrupt",
        reason: `identity mismatch at ${path}: file key=${JSON.stringify(String(id))} but record.workerId=${JSON.stringify(String(parsed.workerId))}`,
      };
    }
    return { kind: "ok", record: parsed };
  };

  // Backwards-compatible accessor used by get()/list() — the L0 interface
  // returns undefined for any absent record and we preserve that shape.
  // Internal callers that need to distinguish missing from corrupt should
  // use readRecordDetailed directly.
  const readRecord = async (id: WorkerId): Promise<BackgroundSessionRecord | undefined> => {
    const outcome = await readRecordDetailed(id);
    return outcome.kind === "ok" ? outcome.record : undefined;
  };

  const register = (record: BackgroundSessionRecord): Promise<Result<void, KoiError>> => {
    const safeId = assertWorkerIdSafe(record.workerId);
    if (!safeId.ok) return Promise.resolve(safeId);
    return serializeWrite(record.workerId, () =>
      underLock(record.workerId, async (_token) => {
        const validation = validateBackgroundSessionRecord(record);
        if (!validation.ok) return validation;
        // Seed version=1 on the first write so CAS retries have a baseline.
        const seeded: BackgroundSessionRecord = { ...record, version: 1 };
        // Even under the lockfile, prefer O_EXCL on the record itself so
        // a crash between lock acquisition and the first write can't
        // silently double-register if lock stealing kicks in.
        const path = recordPath(record.workerId);
        await ensureDir();
        // Atomic register: write a sibling tmp file, then rename onto
        // the final path. The rename replaces ONLY if the target
        // doesn't already exist — we emulate O_EXCL across the rename
        // by stat()ing the final path under the lock first. A crash
        // between writeFile and rename leaves the tmp file behind
        // (harmless — list() ignores non-.json filenames) rather than
        // producing a truncated final record that readers could see.
        try {
          const current = await stat(path).catch(() => undefined);
          if (current !== undefined) {
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: `Session ${record.workerId} is already registered`,
                retryable: false,
                context: { workerId: String(record.workerId) },
              },
            };
          }
        } catch {
          // stat failure other than ENOENT is implausible given
          // ensureDir succeeded; fall through to the write and surface
          // any real error from writeFile/rename.
        }
        const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(seeded, null, 2), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          // Re-check right before rename to catch a concurrent
          // registrant that won the race against our stat above. If
          // we lost, don't clobber their record.
          const after = await stat(path).catch(() => undefined);
          if (after !== undefined) {
            await rm(tmp, { force: true }).catch(() => {});
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: `Session ${record.workerId} is already registered`,
                retryable: false,
                context: { workerId: String(record.workerId) },
              },
            };
          }
          await rename(tmp, path);
        } catch (e) {
          await rm(tmp, { force: true }).catch(() => {});
          const err = e as NodeJS.ErrnoException;
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: `Failed to persist session record: ${err.message ?? String(e)}`,
              retryable: true,
              context: { workerId: String(record.workerId) },
            },
          };
        }
        emit({ kind: "registered", record: seeded });
        return { ok: true, value: undefined };
      }),
    );
  };

  const update = (
    id: WorkerId,
    patch: BackgroundSessionUpdate,
  ): Promise<Result<BackgroundSessionRecord, KoiError>> => {
    const safeId = assertWorkerIdSafe(id);
    if (!safeId.ok) return Promise.resolve(safeId);
    return serializeWrite(id, () =>
      underLock(id, async (token) => {
        // Under the lockfile we have true mutual exclusion, so the CAS
        // check becomes belt-and-suspenders: catches an earlier writer that
        // stole a stale lock or skipped the protocol. Keeping the retry
        // loop costs nothing and guards against those edge cases.
        for (let attempt = 0; attempt < UPDATE_MAX_RETRIES; attempt++) {
          const outcome = await readRecordDetailed(id);
          if (outcome.kind === "missing") {
            return {
              ok: false,
              error: {
                code: "NOT_FOUND",
                message: `Session ${id} is not registered`,
                retryable: false,
                context: { workerId: String(id) },
              },
            };
          }
          if (outcome.kind !== "ok") {
            // Permission, I/O, or parse failure — do NOT alias to NOT_FOUND.
            // Operators need to see the underlying cause to recover (rotate
            // perms, quarantine the malformed file, restore from backup).
            return {
              ok: false,
              error: {
                code: "INTERNAL",
                message: `Session ${id} registry read failed: ${outcome.reason}`,
                retryable: outcome.kind === "io-error",
                context: { workerId: String(id) },
              },
            };
          }
          const existing = outcome.record;
          const expectedVersion = existing.version ?? 0;
          // Caller-supplied CAS guard: if the caller captured a specific
          // version/pid and asks us to fail on drift, honor it BEFORE we
          // bump the version. The lockfile plus this check mean the
          // "identity drift" window is closed — a respawn mid-kill now
          // surfaces as CONFLICT instead of silently overwriting the
          // replacement session as terminated.
          if (patch.expectedVersion !== undefined && patch.expectedVersion !== expectedVersion) {
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: `Session ${id} version drift: caller expected ${patch.expectedVersion}, registry has ${expectedVersion}`,
                retryable: false,
                context: { workerId: String(id) },
              },
            };
          }
          if (patch.expectedPid !== undefined && patch.expectedPid !== existing.pid) {
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: `Session ${id} pid drift: caller expected ${patch.expectedPid}, registry has ${existing.pid}`,
                retryable: false,
                context: { workerId: String(id) },
              },
            };
          }
          // Build the merged record. When `clearTerminal` is set we drop
          // the prior terminal fields FIRST so a later `endedAt`/`exitCode`
          // in the same patch still wins (unusual, but well-defined).
          const base: BackgroundSessionRecord = patch.clearTerminal
            ? (() => {
                const { endedAt: _e, exitCode: _c, ...rest } = existing;
                return rest;
              })()
            : existing;
          const merged: BackgroundSessionRecord = {
            ...base,
            ...(patch.status !== undefined && { status: patch.status }),
            ...(patch.endedAt !== undefined && { endedAt: patch.endedAt }),
            ...(patch.exitCode !== undefined && { exitCode: patch.exitCode }),
            ...(patch.sessionId !== undefined && { sessionId: patch.sessionId }),
            ...(patch.logPath !== undefined && { logPath: patch.logPath }),
            ...(patch.pid !== undefined && { pid: patch.pid }),
            ...(patch.startedAt !== undefined && { startedAt: patch.startedAt }),
            version: expectedVersion + 1,
          };
          // CAS: write tmp → re-read current persisted version → rename only
          // if it still matches what we read at the start of this attempt.
          // Between the version check and the rename there is still a tiny
          // window where a faster writer could slip in, but the version bump
          // guarantees the next observer detects the drift.
          const cas = await writeAtomicCas(id, merged, expectedVersion, token);
          if (cas.ok) {
            emit({ kind: "updated", record: merged });
            return { ok: true, value: merged };
          }
          if (cas.error.code !== "CONFLICT") return cas;
          // Conflict: a concurrent writer bumped the version. Loop and reload.
          // If the caller provided a CAS guard, a re-read can never satisfy it
          // (version is monotonic), so surface the conflict immediately rather
          // than spinning through the retry budget.
          if (patch.expectedVersion !== undefined || patch.expectedPid !== undefined) {
            return cas;
          }
        }
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Session ${id} update exceeded ${UPDATE_MAX_RETRIES} CAS retries`,
            retryable: true,
            context: { workerId: String(id) },
          },
        };
      }),
    );
  };

  const unregister = (id: WorkerId): Promise<Result<void, KoiError>> => {
    const safeId = assertWorkerIdSafe(id);
    if (!safeId.ok) return Promise.resolve(safeId);
    return serializeWrite(id, () =>
      underLock(id, async (token) => {
        // If a stealer has already transferred the lock elsewhere, don't
        // delete a record the new owner may be about to populate.
        if (!(await stillOwnsLock(id, token))) {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Session ${id} lost lockfile ownership before unregister (stolen as stale)`,
              retryable: true,
              context: { workerId: String(id) },
            },
          };
        }
        try {
          await rm(recordPath(id), { force: true });
          emit({ kind: "unregistered", workerId: id });
          return { ok: true, value: undefined };
        } catch (e) {
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: `Failed to remove session record: ${e instanceof Error ? e.message : String(e)}`,
              retryable: true,
              context: { workerId: String(id) },
            },
          };
        }
      }),
    );
  };

  const get = async (id: WorkerId): Promise<BackgroundSessionRecord | undefined> => {
    // Keep L0 semantics: any non-retrievable outcome collapses to undefined.
    // Operator commands should use describe() instead to distinguish
    // "absent" from "unreadable".
    if (!checkWorkerIdSyntax(id).ok) return undefined;
    return readRecord(id);
  };

  const describe = async (
    id: WorkerId,
  ): Promise<Result<BackgroundSessionRecord | undefined, KoiError>> => {
    const safeId = assertWorkerIdSafe(id);
    if (!safeId.ok) return safeId;
    const outcome = await readRecordDetailed(id);
    switch (outcome.kind) {
      case "ok":
        return { ok: true, value: outcome.record };
      case "missing":
        return { ok: true, value: undefined };
      case "corrupt":
      case "io-error":
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Session ${id} registry read failed: ${outcome.reason}`,
            retryable: outcome.kind === "io-error",
            context: { workerId: String(id) },
          },
        };
    }
  };

  const list = async (): Promise<readonly BackgroundSessionRecord[]> => {
    // Lenient accessor for the L0 interface: return whatever records
    // can be read, skipping entries that fail validation or parsing.
    // Operator commands should use describeList() instead — it fails
    // loudly on corruption rather than silently dropping entries.
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const records: BackgroundSessionRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5) as WorkerId;
      if (!checkWorkerIdSyntax(id as WorkerId).ok) continue;
      const record = await readRecord(id);
      if (record !== undefined) records.push(record);
    }
    return records;
  };

  const describeList = async (): Promise<Result<readonly BackgroundSessionRecord[], KoiError>> => {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // Treat the "directory doesn't exist yet" case as empty — registries
      // are lazy-created on first register(). Any other filesystem fault
      // (EACCES, EIO, ENOTDIR) is a real operator signal and must be
      // surfaced instead of silently masked as "no sessions".
      if (err.code === "ENOENT") return { ok: true, value: [] };
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to list session records in ${dir}: ${err.message ?? String(e)}`,
          retryable: true,
          context: { dir },
        },
      };
    }
    const records: BackgroundSessionRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5) as WorkerId;
      // Skip files whose names fail the workerId safety check — they
      // can't be real registry entries and are likely operator-placed
      // debris. Report them as corrupt rather than silently dropping.
      if (!checkWorkerIdSyntax(id as WorkerId).ok) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Registry directory ${dir} contains non-conforming filename ${JSON.stringify(file)}`,
            retryable: false,
            context: { dir },
          },
        };
      }
      const outcome = await readRecordDetailed(id);
      if (outcome.kind === "ok") {
        records.push(outcome.record);
        continue;
      }
      if (outcome.kind === "missing") continue; // Raced against unregister — fine.
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Registry entry for ${id} is unreadable: ${outcome.reason}`,
          retryable: outcome.kind === "io-error",
          context: { workerId: String(id), dir },
        },
      };
    }
    return { ok: true, value: records };
  };

  const watch = async function* (): AsyncIterable<BackgroundSessionEvent> {
    const queue: BackgroundSessionEvent[] = [];
    let resolveNext: ((value: BackgroundSessionEvent) => void) | undefined;
    const listener = (event: BackgroundSessionEvent): void => {
      if (resolveNext !== undefined) {
        const r = resolveNext;
        resolveNext = undefined;
        r(event);
      } else {
        queue.push(event);
      }
    };
    listeners.add(listener);
    try {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        yield await new Promise<BackgroundSessionEvent>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      listeners.delete(listener);
    }
  };

  return { register, update, unregister, get, list, watch, describe, describeList };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is BackgroundSessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.workerId === "string" &&
    typeof r.agentId === "string" &&
    typeof r.pid === "number" &&
    typeof r.status === "string" &&
    typeof r.startedAt === "number" &&
    typeof r.logPath === "string" &&
    Array.isArray(r.command) &&
    typeof r.backendKind === "string"
  );
}
