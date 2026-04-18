/**
 * Plan-persist file backend — owns the in-process mirror, the disk
 * layout, and all I/O. The middleware in plan-persist-middleware.ts
 * adapts this backend to `wrapToolCall` for the koi_plan_save and
 * koi_plan_load tools.
 *
 * Two on-disk surfaces:
 *
 * 1. **Active journal** — `<baseDir>/_active/<sessionHash>.md`
 *    Written by `onPlanUpdate` on every successful `write_plan` so a
 *    crash, `/clear`, or process restart does NOT lose the latest plan.
 *    The package's "survives session restart" guarantee depends on this
 *    file existing — the model never has to remember to call save.
 *
 * 2. **Named checkpoints** — `<baseDir>/<YYYYMMDD-HHmmss>-<slug>.md`
 *    Written by `koi_plan_save` for human-meaningful labels, git-diffable
 *    history, and cross-session reuse.
 *
 * Both writes use exclusive-create commit semantics (`writeFile` to a
 * temp path then `link` to the final path). `link` is atomic and fails
 * with `EEXIST` instead of overwriting, so two concurrent saves with the
 * same `<timestamp>-<slug>` collision cannot silently clobber each other.
 * The journal write uses temp+rename because overwriting the prior
 * journal for the SAME session is the intended semantic.
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join, sep } from "node:path";
import { KoiRuntimeError } from "@koi/errors";
import {
  DEFAULT_BASE_DIR,
  type PlanPersistConfig,
  type PlanPersistFs,
  validatePlanPersistConfig,
} from "./config.js";
import {
  generatePlanMarkdown,
  generateSlug,
  generateTimestamp,
  parsePlanMarkdown,
  validateSlug,
} from "./format.js";
import { resolveBaseDir, resolveSafePath } from "./path-safety.js";
import type { OnPlanUpdate, PlanItem } from "./types.js";

/** In-process mirror of the most recent plan committed for a given session. */
interface PlanMirror {
  readonly items: readonly PlanItem[];
  readonly epoch: number;
  readonly turnIndex: number;
  readonly generatedAt: number;
}

export interface PlanPersistBackend {
  /** Pass to `createPlanMiddleware({ onPlanUpdate })`. */
  readonly onPlanUpdate: OnPlanUpdate;
  /** Diagnostic accessor for the in-process mirror. */
  readonly getActivePlan: (sessionId: string) => readonly PlanItem[] | undefined;
  /** Save the latest mirrored plan for `sessionId` to disk under an optional slug. */
  readonly savePlan: (sessionId: string, slug?: string) => Promise<SavePlanResult>;
  /** Load and parse a plan file. */
  readonly loadPlan: (path: string) => Promise<LoadPlanResult>;
  /**
   * Delete the active journal for `sessionId`. Call when the host
   * intends a logical reset (e.g. `/clear`, `cycleSession`) where the
   * sessionId is reused but a fresh plan is required. Silent on
   * not-found; surfaces non-ENOENT failures via the returned Result so
   * the caller can decide whether to retry or alert.
   */
  readonly clearJournal: (sessionId: string) => Promise<ClearJournalResult>;
  /**
   * Restore the active journal for `sessionId` into the in-process mirror.
   * Use at session-start to recover plans across process restarts.
   *
   * Returns a structured result so the host can distinguish three
   * outcomes that all silently collapsed to "nothing to restore" in
   * earlier revisions:
   *   - `{ ok: true, items }` — journal recovered, mirror rehydrated.
   *   - `{ ok: false, reason: "not-found" }` — no journal exists; safe
   *     to start fresh.
   *   - `{ ok: false, reason: "io-error", cause }` — disk read failed
   *     for a reason other than ENOENT (EACCES, EIO, etc.). The host
   *     should log/alert; do NOT assume the plan was empty.
   *   - `{ ok: false, reason: "corrupt", details }` — journal exists
   *     but failed to parse. Same handling as `io-error`.
   */
  readonly restoreFromJournal: (sessionId: string) => Promise<RestoreJournalResult>;
  /** Drop the in-process mirror entry. Does NOT delete the on-disk journal. */
  readonly dropSession: (sessionId: string) => void;
  /** Absolute path to the resolved plans directory. */
  readonly baseDir: string;
  /** Absolute path to the active-journal directory under baseDir. */
  readonly journalDir: string;
}

export type SavePlanResult =
  | { readonly ok: true; readonly path: string; readonly items: readonly PlanItem[] }
  | { readonly ok: false; readonly error: string };

export type LoadPlanResult =
  | { readonly ok: true; readonly path: string; readonly items: readonly PlanItem[] }
  | { readonly ok: false; readonly error: string };

/** Outcome of clearing the active journal for a session. */
export type ClearJournalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "io-error"; readonly cause: unknown };

/**
 * Outcome of a journal-restore attempt. Distinguishing "no journal" from
 * real I/O or corruption errors prevents silent data loss: a host that
 * sees `not-found` knows there is genuinely nothing to recover, while
 * `io-error` and `corrupt` surface conditions that should be logged or
 * raised to the operator instead of being treated as a fresh start.
 */
export type RestoreJournalResult =
  | { readonly ok: true; readonly items: readonly PlanItem[] }
  | { readonly ok: false; readonly reason: "not-found" }
  | {
      readonly ok: false;
      readonly reason: "io-error";
      readonly cause: unknown;
    }
  | {
      readonly ok: false;
      readonly reason: "corrupt";
      readonly details: string;
    };

const MAX_FILENAME_COLLISION_ATTEMPTS = 10;
const JOURNAL_DIR_NAME = "_active";

/**
 * Process-local monotonic counter for temp-filename uniqueness. Combined
 * with `pid` and `rand()`, this guarantees a fresh temp path per save
 * attempt even when callers inject a deterministic / fixed PRNG (which
 * the public config surface explicitly supports for tests). Without it,
 * two concurrent `savePlan` calls with a fixed `rand` would derive the
 * same temp path and the second `writeFile` would clobber the first's
 * temp contents — leading to cross-session checkpoint corruption.
 */
let tempCounter = 0;

/**
 * Build a plan-persist file backend. Throws synchronously when `baseDir`
 * resolves outside `cwd` (a misconfiguration the host cannot recover from
 * at runtime).
 */
export function createPlanPersistBackend(config?: PlanPersistConfig): PlanPersistBackend {
  const validated = validatePlanPersistConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }
  const cwd = validated.value.cwd ?? process.cwd();
  const baseDirInput = validated.value.baseDir ?? DEFAULT_BASE_DIR;

  const resolvedBase = resolveBaseDir(baseDirInput, cwd);
  if (!resolvedBase.ok) {
    throw KoiRuntimeError.from("VALIDATION", resolvedBase.error);
  }
  const baseDir = resolvedBase.path;
  const journalDir = join(baseDir, JOURNAL_DIR_NAME);

  const fs: PlanPersistFs = validated.value.fs ?? defaultFs();
  const now = validated.value.now ?? Date.now;
  const rand = validated.value.rand ?? Math.random;

  const mirrors = new Map<string, PlanMirror>();

  // Per-session epoch ceiling — drops stale-epoch writes from a torn-down
  // session that finishes its hook AFTER the same sessionId has been
  // recycled with a higher epoch. The planning middleware's pre-hook
  // `stillCurrent` check rejects most stale calls before they reach us,
  // but a hook awaiting `writeJournal` while the session is replaced is
  // still in flight here. Backend-level CAS closes that window.
  const epochCeiling = new Map<string, number>();

  // Per-session serial writer — guarantees journal writes for the SAME
  // sessionId commit in arrival order across concurrent epochs. Without
  // this, two concurrent `writeJournal` calls (e.g. an old hook racing
  // a new one for the same sessionId) could complete out of order and
  // leave the older snapshot on disk.
  const sessionWriteChain = new Map<string, Promise<void>>();

  // Lazy-resolved canonical baseDir. macOS aliases /tmp -> /private/tmp via
  // a symlink; realpath of any saved file under baseDir returns the
  // canonical form while baseDir itself is still the user-supplied value.
  // Without canonicalizing both sides we'd incorrectly reject legitimate
  // saved files at load time. Cached after the first ensure-and-realpath.
  // let justified: single-slot lazy cache for the canonical baseDir
  let baseDirRealCache: string | undefined;
  const ensureBaseDirReal = async (): Promise<string> => {
    if (baseDirRealCache !== undefined) return baseDirRealCache;
    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(journalDir, { recursive: true });
    baseDirRealCache = await fs.realpath(baseDir);
    return baseDirRealCache;
  };

  const writeJournal = async (
    sessionId: string,
    mirror: PlanMirror,
    signal: AbortSignal,
  ): Promise<void> => {
    await ensureBaseDirReal();
    const md = generatePlanMarkdown(mirror.items, {
      generated: new Date(mirror.generatedAt).toISOString(),
      sessionId,
      epoch: mirror.epoch,
      turnIndex: mirror.turnIndex,
    });
    const journalPath = journalPathFor(journalDir, sessionId);
    // Overwrite is intentional here — the active journal is the latest
    // snapshot for THIS session, not a checkpoint history. Use temp+rename
    // for atomicity (no partial files on crash) but allow replacement.
    // The abort signal is honored between writeFile and rename so a
    // teardown that fires mid-write does NOT commit a stale journal.
    await atomicReplace(journalPath, md, fs, rand, signal);
  };

  const onPlanUpdate: OnPlanUpdate = async (plan, ctx) => {
    if (ctx.signal.aborted) return;
    // Pre-write epoch CAS: drop strictly older epochs. Equal-epoch is
    // permitted so multiple turns within the same epoch can each commit
    // their plan in order.
    const ceilingBefore = epochCeiling.get(ctx.sessionId) ?? -1;
    if (ctx.epoch < ceilingBefore) return;
    epochCeiling.set(ctx.sessionId, ctx.epoch);

    const mirror: PlanMirror = {
      items: plan,
      epoch: ctx.epoch,
      turnIndex: ctx.turnIndex,
      generatedAt: now(),
    };

    // Per-session serial writer. Each onPlanUpdate awaits the previous
    // chain entry before doing its journal write, so out-of-order
    // completions cannot reorder snapshots on disk. We re-check both
    // the abort signal AND the epoch ceiling INSIDE the queued slot —
    // a newer epoch may have arrived while we were queued, in which
    // case our write is now stale and must be dropped to avoid
    // overwriting the newer journal.
    const tail = sessionWriteChain.get(ctx.sessionId) ?? Promise.resolve();
    const mine = (async (): Promise<void> => {
      try {
        await tail;
      } catch (_e: unknown) {
        // Predecessor's failure must not poison the chain — we still
        // get our turn. The predecessor's caller already received its
        // own rejection; we only care about ordering, not its outcome.
      }
      if (ctx.signal.aborted) return;
      const ceilingNow = epochCeiling.get(ctx.sessionId) ?? -1;
      if (ctx.epoch < ceilingNow) return;

      // Write journal FIRST. If durable persistence fails, the in-
      // memory mirror must NOT be updated — otherwise getActivePlan +
      // savePlan would surface a plan the planning middleware will
      // report as failed, creating split-brain where the journal is
      // missing but a later koi_plan_save can still checkpoint the
      // rejected plan. Awaiting also means a disk failure propagates
      // as a write_plan tool failure.
      await writeJournal(ctx.sessionId, mirror, ctx.signal);

      // Final-state checks before publishing. A teardown that fired
      // mid-write, or a newer epoch that overtook us, means our
      // mirror update would surface stale data — skip it. (The on-
      // disk journal is still consistent because writeJournal uses
      // atomic temp+rename; if a newer epoch wrote after us, its
      // newer snapshot already won the rename race.)
      if (ctx.signal.aborted) return;
      const ceilingFinal = epochCeiling.get(ctx.sessionId) ?? -1;
      if (ctx.epoch < ceilingFinal) return;
      mirrors.set(ctx.sessionId, mirror);
    })();
    sessionWriteChain.set(
      ctx.sessionId,
      mine.catch(() => undefined),
    );
    return mine;
  };

  const savePlan = async (sessionId: string, slug?: string): Promise<SavePlanResult> => {
    const mirror = mirrors.get(sessionId);
    if (mirror === undefined) {
      return { ok: false, error: "no plan to save" };
    }
    const slugResult = resolveSlug(slug, rand);
    if (!slugResult.ok) return slugResult;

    await ensureBaseDirReal();

    const ts = generateTimestamp(new Date(mirror.generatedAt));
    const md = generatePlanMarkdown(mirror.items, {
      generated: new Date(mirror.generatedAt).toISOString(),
      sessionId,
      epoch: mirror.epoch,
      turnIndex: mirror.turnIndex,
    });

    const committed = await exclusiveCommitWithRetry(baseDir, ts, slugResult.slug, md, fs, rand);
    if (!committed.ok) return committed;
    return { ok: true, path: committed.path, items: mirror.items };
  };

  const loadPlan = async (path: string): Promise<LoadPlanResult> => {
    const baseDirReal = await ensureBaseDirReal();
    const safe = await resolveSafePath(path, baseDir, baseDirReal, cwd, fs);
    if (!safe.ok) return safe;
    // Refuse to load active-journal files through the model-callable
    // path. Journals are per-session ownership state keyed by
    // sha256(sessionId); leaking another session's journal would
    // bypass the package's session-isolation contract. Hosts that
    // legitimately need the active journal call `restoreFromJournal`
    // directly, which requires the sessionId at the API boundary.
    // Named checkpoints (top-level <ts>-<slug>.md) remain loadable —
    // those are explicitly designed for cross-session reuse per the
    // issue spec ("plans should survive restarts, be git-diffable,
    // editable by the user").
    const journalDirReal = await fs.realpath(journalDir).catch(() => journalDir);
    if (safe.path === journalDirReal || safe.path.startsWith(journalDirReal + sep)) {
      return {
        ok: false,
        error: "active journal not loadable via plan_load — use restoreFromJournal",
      };
    }
    let source: string;
    try {
      source = await fs.readFile(safe.path, "utf8");
    } catch (_e: unknown) {
      return { ok: false, error: "file not found" };
    }
    const parsed = parsePlanMarkdown(source);
    if (!parsed.ok) {
      return { ok: false, error: `invalid plan format: ${parsed.error}` };
    }
    return { ok: true, path: safe.path, items: parsed.items };
  };

  const restoreFromJournal = async (sessionId: string): Promise<RestoreJournalResult> => {
    await ensureBaseDirReal();
    const journalPath = journalPathFor(journalDir, sessionId);
    let source: string;
    try {
      source = await fs.readFile(journalPath, "utf8");
    } catch (e: unknown) {
      if (isEnoent(e)) return { ok: false, reason: "not-found" };
      // Surface non-ENOENT errors instead of silently treating them as
      // "no journal" — a host that cannot tell ENOENT apart from
      // EACCES would silently lose the latest plan on every recovery.
      return { ok: false, reason: "io-error", cause: e };
    }
    const parsed = parsePlanMarkdown(source);
    if (!parsed.ok) {
      return { ok: false, reason: "corrupt", details: parsed.error };
    }
    const items = parsed.items;
    // Rehydrate the mirror so subsequent savePlan calls can checkpoint
    // the recovered plan without requiring a fresh write_plan first.
    mirrors.set(sessionId, {
      items,
      epoch: 0,
      turnIndex: -1,
      generatedAt: now(),
    });
    return { ok: true, items };
  };

  const getActivePlan = (sessionId: string): readonly PlanItem[] | undefined =>
    mirrors.get(sessionId)?.items;

  const clearJournal = async (sessionId: string): Promise<ClearJournalResult> => {
    // Capture tail SYNCHRONOUSLY before any await — otherwise a
    // concurrent `onPlanUpdate` invoked while we're parked at
    // `await ensureBaseDirReal()` could insert itself ahead of us in
    // the chain and run BEFORE our unlink. The pre-await lookup
    // guarantees we serialize after every write that was already
    // pending at the moment the host called clearJournal.
    const tail = sessionWriteChain.get(sessionId) ?? Promise.resolve();
    const journalPath = journalPathFor(journalDir, sessionId);
    const mine = (async (): Promise<ClearJournalResult> => {
      try {
        await tail;
      } catch (_e: unknown) {
        // Predecessor failures don't affect our ability to clear.
      }
      await ensureBaseDirReal();
      // Drop in-process state for this sessionId so a post-clear
      // `koi_plan_save` cannot re-checkpoint the cleared plan and so a
      // recycled sessionId is not constrained by the prior incarnation's
      // ceiling. We do NOT delete `sessionWriteChain[sessionId]` here:
      // the outer scope sets it to OUR promise before returning, which
      // forces any concurrent `onPlanUpdate` to enqueue *behind* the
      // unlink. Removing the chain entry mid-clear would let a racing
      // writer slot in with `tail = Promise.resolve()` and recreate the
      // journal between our delete and the unlink. The chain entry is
      // collected later by `dropSession` after the planning middleware
      // has drained.
      mirrors.delete(sessionId);
      epochCeiling.delete(sessionId);
      try {
        await fs.unlink(journalPath);
        return { ok: true };
      } catch (e: unknown) {
        if (isEnoent(e)) return { ok: true };
        return { ok: false, reason: "io-error", cause: e };
      }
    })();
    sessionWriteChain.set(
      sessionId,
      mine.then(
        () => undefined,
        () => undefined,
      ),
    );
    return mine;
  };

  const dropSession = (sessionId: string): void => {
    mirrors.delete(sessionId);
    // Drop the per-session bookkeeping too. Without this, every
    // distinct sessionId seen in a long-lived process would leak an
    // epoch ceiling and a resolved promise forever. The aborted-signal
    // check at the top of `onPlanUpdate` already protects against
    // stale writes from the prior incarnation, so a fresh ceiling is
    // safe — the abort path catches the late stragglers, not the CAS.
    epochCeiling.delete(sessionId);
    sessionWriteChain.delete(sessionId);
    // Intentionally do NOT remove the journal file. Process restarts
    // call onSessionEnd before exit; if we deleted the journal here,
    // the next process could not recover the plan. Hosts that want a
    // hard reset should clear `<baseDir>/_active/` themselves.
  };

  return {
    onPlanUpdate,
    getActivePlan,
    savePlan,
    loadPlan,
    restoreFromJournal,
    clearJournal,
    dropSession,
    baseDir,
    journalDir,
  };
}

function resolveSlug(
  slug: string | undefined,
  rand: () => number,
): { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly error: string } {
  if (slug === undefined) {
    return { ok: true, slug: generateSlug(rand) };
  }
  return validateSlug(slug);
}

/**
 * Map a sessionId to a filesystem-safe filename. SessionIds are runtime-
 * derived strings whose character set is not constrained by this package
 * (Koi accepts arbitrary opaque ids). A short SHA-256 prefix gives a
 * collision-resistant, fixed-length, alphanumeric key without leaking the
 * raw sessionId into the filename.
 */
function journalPathFor(journalDir: string, sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(journalDir, `${hash}.md`);
}

/**
 * Commit `data` to a fresh `<ts>-<slug>[-N].md` under `baseDir` using
 * exclusive-create semantics — writes a temp file then `link`s it into
 * place. `link` is atomic and fails with `EEXIST`, so concurrent commits
 * with the same slug cannot silently overwrite each other; on EEXIST we
 * bump the suffix and retry. Replaces the previous TOCTOU `stat`-then-
 * `rename` pattern that allowed silent clobber under concurrency.
 */
async function exclusiveCommitWithRetry(
  baseDir: string,
  ts: string,
  slug: string,
  data: string,
  fs: PlanPersistFs,
  rand: () => number,
): Promise<
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }
> {
  // Temp path = pid + monotonic counter + rand. Counter alone guarantees
  // intra-process uniqueness even under a fixed PRNG; pid+rand cover the
  // cross-process case for shared baseDirs.
  tempCounter += 1;
  const tmp = join(
    baseDir,
    `.tmp.${String(process.pid)}.${String(tempCounter)}.${String(Math.floor(rand() * 1e9))}.md`,
  );
  await fs.writeFile(tmp, data);
  try {
    for (let i = 0; i <= MAX_FILENAME_COLLISION_ATTEMPTS; i++) {
      const suffix = i === 0 ? "" : `-${String(i)}`;
      const candidate = join(baseDir, `${ts}-${slug}${suffix}.md`);
      try {
        await fs.link(tmp, candidate);
        return { ok: true, path: candidate };
      } catch (e: unknown) {
        if (!isEexist(e)) {
          throw e;
        }
        // EEXIST — try the next suffix.
      }
    }
    return { ok: false, error: "filename collision" };
  } finally {
    try {
      await fs.unlink(tmp);
    } catch (_unlinkErr: unknown) {
      // Tmp file may already be gone if a concurrent cleanup raced; ignore.
    }
  }
}

/**
 * Replace `path` atomically, honoring an abort signal between the temp
 * write and the rename. Used for the active journal where overwrite is
 * the intended semantic. Concurrent writers for the SAME journal path
 * are not expected (the planning middleware serializes commits per
 * session), but rename's atomicity still guarantees readers never see a
 * partial file mid-write.
 *
 * If `signal` aborts after the temp write completes, the rename is
 * skipped and the temp file is unlinked. This closes a race where a
 * teardown that fires mid-write would otherwise commit a stale journal
 * snapshot that the next session-start could resurrect.
 */
async function atomicReplace(
  path: string,
  data: string,
  fs: PlanPersistFs,
  rand: () => number,
  signal: AbortSignal,
): Promise<void> {
  tempCounter += 1;
  const tmp = `${path}.tmp.${String(process.pid)}.${String(tempCounter)}.${String(Math.floor(rand() * 1e9))}`;
  await fs.writeFile(tmp, data);
  if (signal.aborted) {
    try {
      await fs.unlink(tmp);
    } catch (_e: unknown) {
      // Ignore — best-effort cleanup; temp may already be gone.
    }
    return;
  }
  try {
    await fs.rename(tmp, path);
  } catch (e: unknown) {
    try {
      await fs.unlink(tmp);
    } catch (_unlinkErr: unknown) {
      // Ignore — temp file may not exist if writeFile failed first.
    }
    throw e;
  }
}

function isEexist(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const code = (e as { readonly code?: unknown }).code;
  return code === "EEXIST";
}

function isEnoent(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const code = (e as { readonly code?: unknown }).code;
  return code === "ENOENT";
}

function defaultFs(): PlanPersistFs {
  return {
    mkdir: (path, opts): Promise<unknown> => nodeFs.mkdir(path, opts),
    writeFile: (path, data): Promise<void> => nodeFs.writeFile(path, data),
    readFile: (path, encoding): Promise<string> => nodeFs.readFile(path, encoding),
    rename: (a, b): Promise<void> => nodeFs.rename(a, b),
    stat: (path): Promise<unknown> => nodeFs.stat(path),
    realpath: (path): Promise<string> => nodeFs.realpath(path),
    unlink: (path): Promise<void> => nodeFs.unlink(path),
    link: (a, b): Promise<void> => nodeFs.link(a, b),
  };
}
