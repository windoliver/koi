/**
 * SQLite-backed implementation of @koi/ace-types stores.
 *
 * Single Database is shared across the four substores. Schema lives in
 * schema.ts; this file holds the factory wiring + row mappers.
 */

import { Database } from "bun:sqlite";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type {
  Playbook,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  PlaybookProvenance,
  PlaybookSection,
  PlaybookStore,
  StructuredPlaybook,
  StructuredPlaybookStore,
  TrajectoryEntry,
  TrajectoryStore,
} from "@koi/ace-types";
import type { JsonObject } from "@koi/core/common";

import { applyPragmas, applySchema, readStoreIdentity } from "./schema.js";

/**
 * Canonical JSON: stringify with deterministically-sorted object keys at every
 * depth. Lets idempotency checks compare stored vs. incoming payloads
 * semantically instead of by raw key insertion order. Arrays preserve order
 * (their order is meaningful in this domain — operations, sections, bullets).
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  });
}

/**
 * Compare two JSON-encoded strings (or nulls) for semantic equality. Re-parses
 * and canonicalizes both sides, so legacy rows written with `JSON.stringify`
 * and new rows written with `canonicalJson` compare equal when their parsed
 * structures match. Critical for upgrade safety: an idempotent retry after
 * deploy must not fail because the historical row was written under the old
 * non-canonical encoding.
 */
/**
 * Strip server-normalized fields from a canonicalized snapshot so two
 * idempotent retries compare equal even after the server applies its
 * normalizations. Removes:
 *   - `provenance.committedAt` (server-stamped commit time)
 *   - `lastReflectedStepIndex` (server-clamped to max(current, incoming) for
 *     watermark monotonicity)
 * A caller cannot reproduce these server-controlled values on a retry, so
 * direct equality on the canonical snapshot would falsely report content
 * drift. Comparing the *caller-controlled* fields is the right invariant.
 */
function stripServerNormalizedFields(snapshotJson: string): string {
  try {
    const parsed = JSON.parse(snapshotJson) as {
      provenance?: { committedAt?: number };
      lastReflectedStepIndex?: number;
    };
    const { lastReflectedStepIndex: _w, ...withoutWatermark } = parsed;
    if (withoutWatermark.provenance !== undefined) {
      const { committedAt: _ignored, ...rest } = withoutWatermark.provenance;
      if (Object.keys(rest).length === 0) {
        const { provenance: _p, ...withoutProv } = withoutWatermark;
        return canonicalJson(withoutProv);
      }
      return canonicalJson({ ...withoutWatermark, provenance: rest });
    }
    return canonicalJson(withoutWatermark);
  } catch {
    return snapshotJson;
  }
}

function jsonEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  try {
    return canonicalJson(JSON.parse(a) as unknown) === canonicalJson(JSON.parse(b) as unknown);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SqlitePlaybookStoreConfig {
  /**
   * Database path. **Required** — there is no global default. The store keys
   * playbooks/trajectories/proposals only by their domain identifiers, with
   * no workspace or tenant column, so a shared default file would let learned
   * state from one project bleed into another. Callers must provide a path
   * scoped to the current workspace/repo (e.g. `<workspaceRoot>/.koi/ace.sqlite`)
   * or `:memory:` for tests.
   */
  readonly path: string;
  /** "process" survives SIGKILL; "os" survives power loss. Default: "process". */
  readonly durability?: "process" | "os";
}

export interface SqlitePlaybookStore {
  readonly playbooks: PlaybookStore;
  readonly structuredPlaybooks: Required<
    Pick<
      StructuredPlaybookStore,
      "get" | "list" | "save" | "remove" | "getVersion" | "lineageSupported"
    >
  >;
  readonly trajectories: TrajectoryStore;
  readonly proposals: PlaybookProposalStore;
  /**
   * Per-database identity (UUID v4). Generated once when the SQLite file is
   * first initialized and immutable thereafter. Resume guards persist this
   * in the session sidecar so a deleted/replaced/swapped database at the
   * same playbook_path is detected — round 7 finding.
   */
  readonly storeId: string;
  readonly close: () => void;
}

export function createSqlitePlaybookStore(config: SqlitePlaybookStoreConfig): SqlitePlaybookStore {
  if (config.path.length === 0) {
    throw new Error("createSqlitePlaybookStore: config.path is required");
  }
  // Ensure the parent directory exists for non-memory paths so callers don't
  // have to mkdir before opening the store.
  if (config.path !== ":memory:") {
    mkdirSync(dirname(config.path), { recursive: true });
  }
  // Single-writer guard. ACE snapshots the playbook set at session start and
  // writes back version-bumped updates at session end. With concurrent TUI
  // processes against one file, both would learn from the same baseline and
  // the second to finish would hit the version-CAS rejection during shutdown,
  // poisoning the session lifecycle. Refuse activation up front instead, with
  // an actionable error. Skipped for ":memory:" (per-process by definition).
  const releaseLock = config.path === ":memory:" ? noopRelease : acquireWriterLock(config.path);
  let db: Database;
  try {
    db = new Database(config.path, { create: true });
    applyPragmas(db, config.durability ?? "process");
    applySchema(db);
  } catch (err) {
    releaseLock();
    throw err;
  }

  return {
    playbooks: createPlaybookStore(db),
    structuredPlaybooks: createStructuredPlaybookStore(db),
    trajectories: createTrajectoryStore(db),
    proposals: createProposalStore(db),
    storeId: readStoreIdentity(db),
    close: () => {
      try {
        db.close();
      } finally {
        releaseLock();
      }
    },
  };
}

const noopRelease = (): void => {};

/**
 * Acquire a writer lock for `dbPath` atomically. Uses O_CREAT|O_EXCL via
 * `openSync(path, "wx")` so two processes racing to create the lockfile
 * cannot both succeed — exactly one open returns the descriptor; the other
 * fails with EEXIST. The PID is then written to the descriptor for stale-
 * lock reclamation.
 *
 * If the exclusive open fails with EEXIST, we read the existing lock's PID
 * and reclaim it iff that PID is no longer alive. The reclaim itself is
 * also atomic: unlink → re-attempt exclusive create. If another live
 * process owns the lock, throw with an actionable error.
 */
interface LockMetadata {
  readonly pid: number;
  /**
   * Stable host boot identifier when one is available from the kernel.
   * On Linux, `/proc/sys/kernel/random/boot_id` is a UUID regenerated only
   * on actual reboot — it is immune to NTP wall-clock corrections, sleep/
   * wake skew, and manual time changes. On platforms without a kernel boot
   * UUID (macOS, Windows), this is `undefined` and reclaim falls back to
   * proven-dead-PID only (operators may need to remove a stranded .lock
   * file by hand after a crash with PID reuse — never automatic eviction
   * based on a wall-clock heuristic).
   */
  readonly bootId: string | undefined;
}

function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function bootIdsMatch(a: string | undefined, b: string | undefined): boolean {
  // Both undefined = same platform without kernel boot UUID. Treat as
  // "unknown / cannot disprove" — boot mismatch reclaim is not triggered.
  if (a === undefined && b === undefined) return true;
  return a === b;
}

function acquireWriterLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.lock`;
  const meta: LockMetadata = { pid: process.pid, bootId: readBootId() };
  // In-process refcount: multiple handles in one process share the lock
  // (same fate, single-threaded). Only unlink when the LAST handle closes,
  // otherwise an early close would drop the lock while another in-process
  // handle is still writing — a foreign process could then grab it and
  // race with us.
  const existing = INPROC_LOCKS.get(lockPath);
  if (existing !== undefined) {
    existing.refcount += 1;
    return makeReleaser(lockPath, meta);
  }
  publishLockAtomic(lockPath, meta, dbPath);
  INPROC_LOCKS.set(lockPath, { refcount: 1 });
  return makeReleaser(lockPath, meta);
}

/**
 * Atomic lock publication: write a fully-populated temp file, fsync it,
 * then link() into the canonical lock path. linkSync fails with EEXIST if
 * the target exists, giving the same atomic create-or-fail semantics as
 * `openSync("wx")` — but a visible `<dbPath>.lock` is *guaranteed* to
 * contain complete owner metadata, so a crash between openSync and
 * writeSync (round 8 finding 1) cannot leave a malformed lockfile that
 * permanently bricks the store.
 *
 * If the link fails because a peer holds the canonical path, run the
 * same reclaim-or-refuse handling as before. EEXIST is the only path
 * where reclaim might fire.
 */
function publishLockAtomic(lockPath: string, meta: LockMetadata, dbPath: string): void {
  const tmpPath = `${lockPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmpPath, "wx");
  try {
    writeSync(fd, JSON.stringify(meta));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmpPath, lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw err;
    }
    // Peer holds the canonical lock. Try reclaim; on success, retry link.
    try {
      reclaimOrRefuseLock(lockPath, dbPath);
      // Reclaim succeeded (lock unlinked). Retry the link exactly once.
      try {
        linkSync(tmpPath, lockPath);
      } catch (linkErr) {
        // Race: another process raced us to the freshly-cleared slot.
        if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            `playbook-store-sqlite: refusing to open ${dbPath} — another process raced ` +
              "to acquire the writer lock. Concurrent ACE writers against one SQLite file are not supported.",
          );
        }
        throw linkErr;
      }
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
    return;
  }
  try {
    unlinkSync(tmpPath);
  } catch {}
}

/**
 * Inspect the current lockfile and either unlink it (stale) or throw with
 * an actionable refusal. A "stale" lock is one of:
 *  - bootId mismatch (rebooted since the lock was written)
 *  - PID dead
 *  - file is empty / unparseable / corrupt (no provable owner exists,
 *    typical of a crash between create and metadata-write — see round 8)
 */
function reclaimOrRefuseLock(lockPath: string, dbPath: string): void {
  let parsed: LockMetadata | undefined;
  let raw: string | undefined;
  try {
    raw = readFileSync(lockPath, "utf8");
    parsed = parseLockMetadata(raw);
  } catch {
    // Unreadable — treat as corrupt below.
  }
  // Same-PID re-open path: handled higher up (INPROC_LOCKS refcount short-
  // circuits before we get here in normal operation). If we somehow reach
  // here with parsed.pid === own.pid, treat as stale — the in-proc map is
  // gone but the lockfile remains.
  if (parsed?.pid === process.pid) {
    try {
      unlinkSync(lockPath);
    } catch {}
    return;
  }
  const myBootId = readBootId();
  const bootMismatched =
    parsed !== undefined &&
    parsed.bootId !== undefined &&
    myBootId !== undefined &&
    !bootIdsMatch(parsed.bootId, myBootId);
  const pidDead = parsed !== undefined && !isProcessAlive(parsed.pid);
  // Corrupt/empty lockfile: no parseable owner. This is the crash-between-
  // create-and-write case. Reclaim — there cannot be a *provable* owner
  // because no metadata was written. (With atomic publish via temp+link,
  // this should not happen for our own writes, but legacy crashes from
  // pre-atomic builds may have left such files behind.)
  const corrupt = raw !== undefined && raw.trim().length > 0 && parsed === undefined;
  const empty = raw !== undefined && raw.trim().length === 0;
  if (parsed !== undefined ? bootMismatched || pidDead : corrupt || empty) {
    try {
      unlinkSync(lockPath);
    } catch {}
    return;
  }
  throw new Error(
    `playbook-store-sqlite: refusing to open ${dbPath} — another process` +
      (parsed !== undefined ? ` (pid ${parsed.pid})` : "") +
      " holds the writer lock. Concurrent ACE writers against one SQLite file are not supported. " +
      `Stop the other process or remove ${lockPath} if it is stale.`,
  );
}

const INPROC_LOCKS = new Map<string, { refcount: number }>();

function makeReleaser(lockPath: string, owned: LockMetadata): () => void {
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const entry = INPROC_LOCKS.get(lockPath);
    if (entry === undefined) return;
    entry.refcount -= 1;
    if (entry.refcount > 0) return;
    INPROC_LOCKS.delete(lockPath);
    try {
      const parsed = parseLockMetadata(readFileSync(lockPath, "utf8"));
      if (parsed?.pid === owned.pid && bootIdsMatch(parsed.bootId, owned.bootId)) {
        unlinkSync(lockPath);
      }
    } catch {
      // Lock file already gone or unreadable; nothing to do.
    }
  };
}

function parseLockMetadata(raw: string): LockMetadata | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // New format: JSON {pid, bootId?}.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<LockMetadata> & {
        readonly bootEpochMs?: number;
      };
      if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
        const bootId = typeof parsed.bootId === "string" ? parsed.bootId : undefined;
        return { pid: parsed.pid, bootId };
      }
    } catch {
      // Fall through.
    }
    return undefined;
  }
  // Legacy format: bare integer PID. PID-aliveness alone gates reclaim,
  // matching pre-bootId behavior.
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  return { pid, bootId: undefined };
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 probes existence without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process exists but we lack permission — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// PlaybookStore
// ---------------------------------------------------------------------------

interface PlaybookRow {
  readonly id: string;
  readonly title: string;
  readonly strategy: string;
  readonly tags: string;
  readonly confidence: number;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly session_count: number;
  readonly version: number;
  readonly provenance: string | null;
}

function createPlaybookStore(db: Database): PlaybookStore {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO playbooks
      (id, title, strategy, tags, confidence, source, created_at, updated_at, session_count, version, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.query("SELECT * FROM playbooks WHERE id = ?");
  const selectAll = db.query("SELECT * FROM playbooks");
  const selectByMinConfidence = db.query("SELECT * FROM playbooks WHERE confidence >= ?");
  const deleteById = db.prepare("DELETE FROM playbooks WHERE id = ?");

  const selectFullById = db.query("SELECT * FROM playbooks WHERE id = ?");

  return {
    save: async (pb) => {
      // Compare-and-swap on version under concurrent writers:
      //   - version < current: stale save, reject.
      //   - version == current: must be byte-identical content (idempotent retry).
      //     Different content at the same version means two concurrent
      //     consolidators derived `prev.version + 1` from the same snapshot
      //     and produced divergent payloads. Accepting either silently loses
      //     the other's learned state — reject and force the caller to
      //     re-derive at version + 1.
      //   - version > current: accept (forward progress).
      // .immediate() acquires RESERVED lock at BEGIN so the read-then-write
      // is serialized against peer writers.
      const incomingTags = canonicalJson(pb.tags);
      const incomingProvenance = pb.provenance !== undefined ? canonicalJson(pb.provenance) : null;
      db.transaction(() => {
        const current = selectFullById.get(pb.id) as PlaybookRow | null;
        if (current !== null) {
          if (pb.version < current.version) {
            throw new Error(
              `playbook ${pb.id} cannot save version ${String(pb.version)} below current version ${String(current.version)}`,
            );
          }
          if (pb.version === current.version) {
            const sameContent =
              current.title === pb.title &&
              current.strategy === pb.strategy &&
              current.confidence === pb.confidence &&
              current.source === pb.source &&
              current.created_at === pb.createdAt &&
              current.updated_at === pb.updatedAt &&
              current.session_count === pb.sessionCount &&
              jsonEqual(current.tags, incomingTags) &&
              jsonEqual(current.provenance, incomingProvenance);
            if (!sameContent) {
              throw new Error(
                `playbook ${pb.id} version ${String(pb.version)} already committed with different content; re-derive at version ${String(pb.version + 1)}`,
              );
            }
            // Identical retry — no-op.
            return;
          }
        }
        upsert.run(
          pb.id,
          pb.title,
          pb.strategy,
          incomingTags,
          pb.confidence,
          pb.source,
          pb.createdAt,
          pb.updatedAt,
          pb.sessionCount,
          pb.version,
          incomingProvenance,
        );
      }).immediate();
    },
    get: async (id) => {
      const row = selectById.get(id) as PlaybookRow | null;
      return row !== null ? rowToPlaybook(row) : undefined;
    },
    list: async (options) => {
      const minConfidence = options?.minConfidence;
      const rows = (
        minConfidence !== undefined
          ? (selectByMinConfidence.all(minConfidence) as readonly PlaybookRow[])
          : (selectAll.all() as readonly PlaybookRow[])
      ).map(rowToPlaybook);
      return filterByTags(rows, options?.tags);
    },
    remove: async (id) => {
      const result = deleteById.run(id);
      return result.changes > 0;
    },
  };
}

function rowToPlaybook(row: PlaybookRow): Playbook {
  const base: Playbook = {
    id: row.id,
    title: row.title,
    strategy: row.strategy,
    tags: JSON.parse(row.tags) as readonly string[],
    confidence: row.confidence,
    source: row.source as Playbook["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
    version: row.version,
  };
  return row.provenance !== null
    ? { ...base, provenance: JSON.parse(row.provenance) as PlaybookProvenance }
    : base;
}

// ---------------------------------------------------------------------------
// StructuredPlaybookStore + lineage
// ---------------------------------------------------------------------------

interface StructuredPlaybookRow {
  readonly id: string;
  readonly title: string;
  readonly sections: string;
  readonly tags: string;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly session_count: number;
  readonly last_reflected_step_index: number | null;
  readonly version: number;
  readonly provenance: string | null;
}

function createStructuredPlaybookStore(db: Database): SqlitePlaybookStore["structuredPlaybooks"] {
  const upsertCurrent = db.prepare(`
    INSERT OR REPLACE INTO structured_playbooks
      (id, title, sections, tags, source, created_at, updated_at, session_count,
       last_reflected_step_index, version, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVersion = db.prepare(`
    INSERT INTO structured_playbook_versions (playbook_id, version, snapshot, committed_at)
    VALUES (?, ?, ?, ?)
  `);
  const selectVersion = db.query(
    "SELECT snapshot FROM structured_playbook_versions WHERE playbook_id = ? AND version = ?",
  );
  const selectCurrentVersion = db.query("SELECT version FROM structured_playbooks WHERE id = ?");
  // Lineage truth: MAX(version) committed for this playbook. Used to compute
  // the effective head when the mutable head row is missing or stale. A
  // partial-failure crash can leave lineage with v5 but no head row; using
  // only the head row for the regression check would let a v3 retry sneak
  // back in as the visible head.
  const selectLineageMaxVersion = db.query(
    "SELECT MAX(version) AS v FROM structured_playbook_versions WHERE playbook_id = ?",
  );
  const selectById = db.query("SELECT * FROM structured_playbooks WHERE id = ?");
  const selectAll = db.query("SELECT * FROM structured_playbooks");
  // Watermark lives in its own table so it survives both head-row loss
  // (the head can be deleted/missing) and lineage immutability (lineage
  // snapshots cannot be rewritten on a same-version retry that observed
  // newer reflection progress).
  const selectWatermarkTable = db.query(
    "SELECT max_step_index FROM structured_playbook_watermarks WHERE playbook_id = ?",
  );
  const upsertWatermark = db.prepare(
    `INSERT INTO structured_playbook_watermarks(playbook_id, max_step_index) VALUES (?, ?)
     ON CONFLICT(playbook_id) DO UPDATE SET max_step_index =
       MAX(max_step_index, excluded.max_step_index)`,
  );
  const selectLatestLineageSnapshot = db.query(
    "SELECT snapshot FROM structured_playbook_versions WHERE playbook_id = ? ORDER BY version DESC LIMIT 1",
  );
  const deleteCurrent = db.prepare("DELETE FROM structured_playbooks WHERE id = ?");
  const deleteLineage = db.prepare(
    "DELETE FROM structured_playbook_versions WHERE playbook_id = ?",
  );
  const deleteWatermark = db.prepare(
    "DELETE FROM structured_playbook_watermarks WHERE playbook_id = ?",
  );

  const save = async (pb: StructuredPlaybook): Promise<void> => {
    // .immediate() acquires the SQLite RESERVED lock at BEGIN, so concurrent
    // identical retriers serialize cleanly instead of racing read snapshots
    // and tripping the version check on a stale view.
    db.transaction(() => {
      // Order matters: reject any below-head replay BEFORE the idempotency
      // short-circuit, otherwise a stale worker that retries an old version
      // resolves silently after head has advanced — losing the race without
      // surfacing it to the caller.
      const current = selectCurrentVersion.get(pb.id) as { readonly version: number } | null;
      const lineageMaxRow = selectLineageMaxVersion.get(pb.id) as {
        readonly v: number | null;
      } | null;
      const lineageMax = lineageMaxRow?.v ?? null;
      // Effective head = current head row if present, else lineage MAX as
      // fallback when the head row is missing (e.g. fresh self-heal scenario).
      // We do NOT take max(current, lineageMax) for monotonic check: a stray
      // higher lineage row from manual repair or historical corruption must
      // not wedge healthy writes against the live head pointer.
      const effectiveHead = current?.version ?? lineageMax ?? null;
      if (effectiveHead !== null && pb.version < effectiveHead) {
        throw new Error(
          `playbook ${pb.id} cannot save version ${String(pb.version)} below current version ${String(effectiveHead)}`,
        );
      }
      // Stamp the lineage commit time AFTER the write lock is held so the
      // audit trail reflects the actual commit moment, not the request
      // arrival moment. Overwrite any caller-supplied provenance.committedAt
      // with the same server time so the snapshot, the current row, and the
      // lineage table cannot diverge on the commit timestamp for one version.
      const committedAt = Date.now();
      const normalizedProvenance =
        pb.provenance !== undefined ? { ...pb.provenance, committedAt } : undefined;
      // Watermark monotonicity: a rollback re-saves an older snapshot, but
      // its `lastReflectedStepIndex` was captured before later reflection
      // ran. Clamping to max(current, incoming) prevents reopening already-
      // processed trajectory windows after a rollback.
      //
      // Source of truth is structured_playbook_watermarks — a separate
      // table that survives both head-row loss AND lineage immutability.
      // Fall back to lineage snapshot only if the watermarks table has no
      // row yet (e.g. fresh playbook on a freshly-migrated v6 DB before
      // any save has populated the table for this id).
      const watermarkRow = selectWatermarkTable.get(pb.id) as {
        readonly max_step_index: number;
      } | null;
      let currentWatermark: number | null;
      if (watermarkRow !== null) {
        currentWatermark = watermarkRow.max_step_index;
      } else {
        const latestRow = selectLatestLineageSnapshot.get(pb.id) as {
          readonly snapshot: string;
        } | null;
        if (latestRow !== null) {
          const latestSnapshot = JSON.parse(latestRow.snapshot) as {
            readonly lastReflectedStepIndex?: number;
          };
          currentWatermark = latestSnapshot.lastReflectedStepIndex ?? null;
        } else {
          currentWatermark = null;
        }
      }
      const incomingWatermark = pb.lastReflectedStepIndex ?? null;
      const monotonicWatermark =
        currentWatermark === null
          ? incomingWatermark
          : incomingWatermark === null
            ? currentWatermark
            : Math.max(currentWatermark, incomingWatermark);
      const { lastReflectedStepIndex: _w, provenance: _p, ...rest } = pb;
      const normalized: StructuredPlaybook = {
        ...rest,
        ...(monotonicWatermark !== null ? { lastReflectedStepIndex: monotonicWatermark } : {}),
        ...(normalizedProvenance !== undefined ? { provenance: normalizedProvenance } : {}),
      };
      const snapshot = canonicalJson(normalized);
      const existing = selectVersion.get(pb.id, pb.version) as { readonly snapshot: string } | null;
      if (existing !== null) {
        // Whether or not the head row is present, the caller payload at an
        // already-committed lineage version must be semantically equal to
        // the stored snapshot (modulo provenance.committedAt which is
        // normalized server-side). A divergent payload is rejected loudly
        // — silent self-heal on missing head with mismatched content would
        // be a lost-update bug.
        if (
          !jsonEqual(
            stripServerNormalizedFields(existing.snapshot),
            stripServerNormalizedFields(snapshot),
          )
        ) {
          throw new Error(
            `playbook ${pb.id} version ${String(pb.version)} already committed with different content`,
          );
        }
        // Self-heal when the head row is missing OR present at this
        // exact version (where it could be stale relative to canonical
        // lineage). Always rebuild from stored snapshot — UPSERT is a
        // no-op when the head already matches and a repair otherwise.
        // We do NOT rebuild when current exists at a DIFFERENT version —
        // that would silently fast-forward (or rewind) the monotonic head.
        if (current === null || current.version === pb.version) {
          const stored = JSON.parse(existing.snapshot) as StructuredPlaybook;
          // Watermark monotonicity on idempotent retry: lastReflectedStepIndex
          // is stripped from the content compare so retries with higher
          // reflection progress don't false-fail as "different content", but
          // we must still PROMOTE the higher watermark into the head row.
          // Otherwise a retry that observed steps 0-100 would silently lose
          // its progress to a prior commit that only saw steps 0-20, causing
          // duplicate reflection work after restart.
          const storedWatermark = stored.lastReflectedStepIndex ?? null;
          const promotedWatermark =
            storedWatermark === null
              ? incomingWatermark
              : incomingWatermark === null
                ? storedWatermark
                : Math.max(storedWatermark, incomingWatermark);
          // Promoted watermark is written to the mutable head row AND to
          // the dedicated structured_playbook_watermarks recovery table.
          // structured_playbook_versions.snapshot remains append-only —
          // mutating it would let a later proposal/rollback anchored to
          // base_version=N observe a different snapshot than the one
          // originally committed. The watermarks table is the recovery-
          // floor source of truth, so the promoted value survives head
          // loss without rewriting historical lineage.
          upsertCurrent.run(
            stored.id,
            stored.title,
            canonicalJson(stored.sections),
            canonicalJson(stored.tags),
            stored.source,
            stored.createdAt,
            stored.updatedAt,
            stored.sessionCount,
            promotedWatermark,
            stored.version,
            stored.provenance !== undefined ? canonicalJson(stored.provenance) : null,
          );
          if (promotedWatermark !== null) {
            upsertWatermark.run(stored.id, promotedWatermark);
          }
        }
        return;
      }
      upsertCurrent.run(
        pb.id,
        pb.title,
        canonicalJson(pb.sections),
        canonicalJson(pb.tags),
        pb.source,
        pb.createdAt,
        pb.updatedAt,
        pb.sessionCount,
        monotonicWatermark,
        pb.version,
        normalizedProvenance !== undefined ? canonicalJson(normalizedProvenance) : null,
      );
      insertVersion.run(pb.id, pb.version, snapshot, committedAt);
      // Persist the monotonic watermark to its dedicated recovery table.
      // ON CONFLICT MAX makes this safe under retry: a stale retrier with
      // a lower watermark can't downgrade what's already recorded.
      if (monotonicWatermark !== null) {
        upsertWatermark.run(pb.id, monotonicWatermark);
      }
    }).immediate();
  };

  return {
    save,
    get: async (id) => {
      const row = selectById.get(id) as StructuredPlaybookRow | null;
      return row !== null ? rowToStructuredPlaybook(row) : undefined;
    },
    list: async (options) => {
      const rows = (selectAll.all() as readonly StructuredPlaybookRow[]).map(
        rowToStructuredPlaybook,
      );
      return filterByTags(rows, options?.tags);
    },
    remove: async (id) => {
      // Refuses deletion when dependent proposals exist. Cascading would
      // wipe the append-only proposal/evaluation audit trail that this
      // package treats as immutable lineage — a bad promotion or
      // rollback could no longer be reconstructed from on-disk state.
      // Operators needing full purge can do explicit raw SQL surgery
      // (this store has no `force` flag because the L0 contract doesn't
      // expose one); the default contract is "remove the playbook,
      // preserve the audit history" so a routine delete cannot silently
      // erase evidence of past promotions.
      //
      // .immediate() acquires the RESERVED write lock at BEGIN so the
      // dependency check + delete sequence is serialized against
      // concurrent proposal inserts.
      try {
        const result = db
          .transaction(() => {
            const dep = db
              .query("SELECT COUNT(*) AS n FROM playbook_proposals WHERE playbook_id = ?")
              .get(id) as { readonly n: number } | null;
            if (dep !== null && dep.n > 0) {
              throw new Error(
                `cannot remove structured playbook ${id}: ${String(dep.n)} dependent proposal(s) exist; preserving append-only audit history. Purge requires explicit operator surgery.`,
              );
            }
            // Return true if EITHER head OR lineage was removed. Returning
            // false when only lineage rows existed (head missing, lineage
            // intact) would hide an irreversible destructive change behind
            // a "not found" result.
            const headDeleted = deleteCurrent.run(id);
            const lineageDeleted = deleteLineage.run(id);
            deleteWatermark.run(id);
            return headDeleted.changes > 0 || lineageDeleted.changes > 0;
          })
          .immediate();
        return result;
      } catch (err: unknown) {
        // Defensive remap: if SQLite still surfaces a FK error (e.g.
        // because some non-proposal table grew an unexpected dependency
        // on lineage), give callers the same domain-typed message instead
        // of leaking SQLITE_CONSTRAINT_FOREIGNKEY.
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? (err as { readonly code?: unknown }).code
            : undefined;
        if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
          throw new Error(
            `cannot remove structured playbook ${id}: dependent rows exist; remove proposals/evaluations first`,
          );
        }
        throw err;
      }
    },
    getVersion: async (id, version) => {
      const row = selectVersion.get(id, version) as { readonly snapshot: string } | null;
      return row !== null ? (JSON.parse(row.snapshot) as StructuredPlaybook) : undefined;
    },
    lineageSupported: true,
  };
}

function rowToStructuredPlaybook(row: StructuredPlaybookRow): StructuredPlaybook {
  const base = {
    id: row.id,
    title: row.title,
    sections: JSON.parse(row.sections) as readonly PlaybookSection[],
    tags: JSON.parse(row.tags) as readonly string[],
    source: row.source as StructuredPlaybook["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
    version: row.version,
  } satisfies Omit<StructuredPlaybook, "lastReflectedStepIndex" | "provenance">;
  const withWatermark =
    row.last_reflected_step_index !== null
      ? { ...base, lastReflectedStepIndex: row.last_reflected_step_index }
      : base;
  return row.provenance !== null
    ? { ...withWatermark, provenance: JSON.parse(row.provenance) as PlaybookProvenance }
    : withWatermark;
}

// ---------------------------------------------------------------------------
// TrajectoryStore
// ---------------------------------------------------------------------------

interface TrajectoryRow {
  readonly session_id: string;
  readonly turn_index: number;
  readonly timestamp: number;
  readonly kind: string;
  readonly identifier: string;
  readonly outcome: string;
  readonly duration_ms: number;
  readonly metadata: string | null;
  readonly bullet_ids: string | null;
}

function createTrajectoryStore(db: Database): TrajectoryStore {
  // Trajectory rows are an append-only audit log keyed by per-session seq, a
  // monotonic counter assigned at append time. Multiple same-tool calls
  // within a single turn round-trip as distinct rows.
  //
  // Append is NOT idempotent: a legitimate second batch with identical
  // contents must persist as additional rows (e.g. the same fs.read sequence
  // genuinely repeated in a later turn block). Callers that need retry
  // dedup after an unknown-commit-state failure must coordinate that
  // themselves (idempotency token, caller-side log, etc.). Matches the
  // in-memory baseline `[...prev, ...entries]` semantics.
  const insert = db.prepare(`
    INSERT INTO trajectory_entries
      (session_id, seq, turn_index, timestamp, kind, identifier, outcome, duration_ms, metadata, bullet_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMaxSeq = db.query(
    "SELECT MAX(seq) AS s FROM trajectory_entries WHERE session_id = ?",
  );
  const selectSession = db.query(
    "SELECT * FROM trajectory_entries WHERE session_id = ? ORDER BY seq",
  );
  const selectSessions = db.query(
    "SELECT session_id FROM trajectory_sessions ORDER BY last_activity_at DESC, session_id ASC LIMIT ?",
  );
  const selectSessionsBefore = db.query(
    "SELECT session_id FROM trajectory_sessions WHERE last_activity_at < ? ORDER BY last_activity_at DESC, session_id ASC LIMIT ?",
  );
  // Upsert last_activity_at to MAX(existing, incoming) so the recency
  // signal advances on every append. INSERT OR REPLACE would clobber the
  // existing row entirely (and any FKs to it), so we use ON CONFLICT to
  // do an in-place max-update.
  const insertSession = db.prepare(
    `INSERT INTO trajectory_sessions(session_id, last_activity_at) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_activity_at =
       MAX(last_activity_at, excluded.last_activity_at)`,
  );

  return {
    append: async (sessionId, entries) => {
      // .immediate() acquires RESERVED at BEGIN so the MAX(seq) read and
      // ensuing inserts serialize against peer writers — concurrent appends
      // can't race on the seq counter. Empty appends still record the
      // session so listSessions() can enumerate it (matches in-memory
      // baseline where opening a session before the first entry leaves it
      // visible). Use the BATCH MAX timestamp (not min) so a mixed batch
      // with timestamps {1000, 3000} stores 3000 — otherwise before=2500
      // would erroneously include a session whose later activity is past
      // the cursor.
      const batchActivity =
        entries.length > 0 ? Math.max(...entries.map((e) => e.timestamp)) : Date.now();
      db.transaction(() => {
        insertSession.run(sessionId, batchActivity);
        if (entries.length === 0) return;
        const maxRow = selectMaxSeq.get(sessionId) as { readonly s: number | null } | null;
        let next = (maxRow?.s ?? 0) + 1;
        for (const e of entries) {
          const meta = e.metadata !== undefined ? canonicalJson(e.metadata) : null;
          const bullets = e.bulletIds !== undefined ? canonicalJson(e.bulletIds) : null;
          insert.run(
            sessionId,
            next,
            e.turnIndex,
            e.timestamp,
            e.kind,
            e.identifier,
            e.outcome,
            e.durationMs,
            meta,
            bullets,
          );
          next += 1;
        }
      }).immediate();
    },
    getSession: async (sessionId) => {
      const rows = selectSession.all(sessionId) as readonly TrajectoryRow[];
      return rows.map(rowToTrajectoryEntry);
    },
    listSessions: async (options) => {
      const limit = options?.limit ?? 1_000_000;
      const before = options?.before;
      const rows =
        before !== undefined
          ? (selectSessionsBefore.all(before, limit) as readonly { readonly session_id: string }[])
          : (selectSessions.all(limit) as readonly { readonly session_id: string }[]);
      return rows.map((r) => r.session_id);
    },
  };
}

function rowToTrajectoryEntry(row: TrajectoryRow): TrajectoryEntry {
  const base = {
    turnIndex: row.turn_index,
    timestamp: row.timestamp,
    kind: row.kind as TrajectoryEntry["kind"],
    identifier: row.identifier,
    outcome: row.outcome as TrajectoryEntry["outcome"],
    durationMs: row.duration_ms,
  };
  const withMeta =
    row.metadata !== null ? { ...base, metadata: JSON.parse(row.metadata) as JsonObject } : base;
  return row.bullet_ids !== null
    ? { ...withMeta, bulletIds: JSON.parse(row.bullet_ids) as readonly string[] }
    : withMeta;
}

// ---------------------------------------------------------------------------
// PlaybookProposalStore
// ---------------------------------------------------------------------------

interface ProposalRow {
  readonly id: string;
  readonly playbook_id: string;
  readonly base_version: number;
  readonly operations: string;
  readonly source_trajectory_range: string;
  readonly reflection: string;
  readonly created_at: number;
}

function createProposalStore(db: Database): PlaybookProposalStore {
  // Proposals + evaluations are the immutable lineage the promotion gate
  // audits. ON CONFLICT DO NOTHING + a same-transaction content compare
  // makes the insert-and-compare path atomic across concurrent retriers:
  // the loser of an insert race re-reads the committed row and accepts the
  // write iff its payload is byte-identical.
  const insertProposal = db.prepare(`
    INSERT INTO playbook_proposals
      (id, playbook_id, base_version, operations, source_trajectory_range, reflection, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertEval = db.prepare(`
    INSERT INTO playbook_evaluations
      (id, proposal_id, verdict, metrics, notes, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const selectProposal = db.query("SELECT * FROM playbook_proposals WHERE id = ?");
  const selectProposalRaw = db.query(
    "SELECT operations, source_trajectory_range, reflection, playbook_id, base_version, created_at FROM playbook_proposals WHERE id = ?",
  );
  const selectEvalRaw = db.query(
    "SELECT verdict, metrics, notes, proposal_id, evaluated_at FROM playbook_evaluations WHERE id = ?",
  );
  const selectByPlaybook = db.query(
    "SELECT * FROM playbook_proposals WHERE playbook_id = ? ORDER BY created_at, id",
  );
  const selectStructuredHeadVersion = db.query(
    "SELECT version FROM structured_playbooks WHERE id = ?",
  );
  const selectStructuredLineageMaxVersion = db.query(
    "SELECT MAX(version) AS v FROM structured_playbook_versions WHERE playbook_id = ?",
  );

  return {
    recordProposal: async (p) => {
      const ops = canonicalJson(p.operations);
      const range = canonicalJson(p.sourceTrajectoryRange);
      const reflection = canonicalJson(p.reflection);
      db.transaction(() => {
        const result = insertProposal.run(
          p.id,
          p.playbookId,
          p.baseVersion,
          ops,
          range,
          reflection,
          p.createdAt,
        );
        if (result.changes > 0) {
          // baseVersion is the documented optimistic-concurrency anchor.
          // Reject stale proposals whose anchor is no longer the effective
          // head — the schema FK only proves the version existed at some
          // point, not that it is current. We check AFTER the insert (not
          // before) so retries land in the content-compare branch below
          // even after the head advances; only fresh inserts pay this cost.
          // When the mutable head row is missing (partial corruption), fall
          // back to MAX(lineage version) — same effective-head policy that
          // structuredPlaybooks.save() uses, so proposal capture is not
          // wedged by the exact missing-head scenario the store self-heals.
          const headRow = selectStructuredHeadVersion.get(p.playbookId) as {
            readonly version: number;
          } | null;
          let effectiveHead: number | null;
          if (headRow !== null) {
            effectiveHead = headRow.version;
          } else {
            const lineageRow = selectStructuredLineageMaxVersion.get(p.playbookId) as {
              readonly v: number | null;
            } | null;
            effectiveHead = lineageRow?.v ?? null;
          }
          if (effectiveHead === null || effectiveHead !== p.baseVersion) {
            throw new Error(
              `proposal ${p.id} baseVersion ${String(p.baseVersion)} does not match current head ${effectiveHead === null ? "(missing)" : String(effectiveHead)} for playbook ${p.playbookId}`,
            );
          }
        }
        if (result.changes === 0) {
          const existing = selectProposalRaw.get(p.id) as {
            readonly operations: string;
            readonly source_trajectory_range: string;
            readonly reflection: string;
            readonly playbook_id: string;
            readonly base_version: number;
            readonly created_at: number;
          } | null;
          const same =
            existing !== null &&
            existing.playbook_id === p.playbookId &&
            existing.base_version === p.baseVersion &&
            existing.created_at === p.createdAt &&
            jsonEqual(existing.operations, ops) &&
            jsonEqual(existing.source_trajectory_range, range) &&
            jsonEqual(existing.reflection, reflection);
          if (!same) {
            throw new Error(`proposal ${p.id} already recorded with different content`);
          }
        }
      })();
    },
    recordEvaluation: async (e) => {
      const metrics = canonicalJson(e.metrics);
      const notes = e.notes ?? null;
      const checkSameContent = (existing: {
        readonly verdict: string;
        readonly metrics: string;
        readonly notes: string | null;
        readonly proposal_id: string;
        readonly evaluated_at: number;
      }): boolean =>
        existing.proposal_id === e.proposalId &&
        existing.verdict === e.verdict &&
        existing.evaluated_at === e.evaluatedAt &&
        jsonEqual(existing.metrics, metrics) &&
        existing.notes === notes;
      db.transaction(() => {
        try {
          const result = insertEval.run(
            e.id,
            e.proposalId,
            e.verdict,
            metrics,
            notes,
            e.evaluatedAt,
          );
          if (result.changes === 0) {
            // Same id collision — compare against the existing row.
            const existing = selectEvalRaw.get(e.id) as {
              readonly verdict: string;
              readonly metrics: string;
              readonly notes: string | null;
              readonly proposal_id: string;
              readonly evaluated_at: number;
            } | null;
            if (existing === null || !checkSameContent(existing)) {
              throw new Error(`evaluation ${e.id} already recorded with different content`);
            }
          }
        } catch (err: unknown) {
          // UNIQUE(proposal_id) violation: a different evaluation id was
          // already recorded for this proposal. A retry that regenerated
          // its evaluation id but reused proposalId should still succeed
          // when the semantic content matches; otherwise surface a
          // domain-typed conflict instead of a raw SQLite constraint.
          const code =
            typeof err === "object" && err !== null && "code" in err
              ? (err as { readonly code?: unknown }).code
              : undefined;
          if (code !== "SQLITE_CONSTRAINT_UNIQUE") {
            throw err;
          }
          const existingByProposal = db
            .query(
              "SELECT id, verdict, metrics, notes, proposal_id, evaluated_at FROM playbook_evaluations WHERE proposal_id = ?",
            )
            .get(e.proposalId) as {
            readonly id: string;
            readonly verdict: string;
            readonly metrics: string;
            readonly notes: string | null;
            readonly proposal_id: string;
            readonly evaluated_at: number;
          } | null;
          if (existingByProposal === null) {
            throw err;
          }
          // Surface the lineage break: the caller's evaluation id will
          // never reach disk because the proposal already has an
          // evaluation under a DIFFERENT id. Returning silent success
          // would leave callers holding a dangling id that cannot be
          // resolved back to stored audit evidence. Even if content
          // matches, refuse the write so callers either reuse the
          // canonical id (visible in the error message) or surface the
          // conflict to the operator.
          throw new Error(
            `evaluation ${e.id} cannot be recorded: proposal ${e.proposalId} already has evaluation ${existingByProposal.id}; reuse that id for retries`,
          );
        }
      })();
    },
    getProposal: async (id) => {
      const row = selectProposal.get(id) as ProposalRow | null;
      return row !== null ? rowToProposal(row) : undefined;
    },
    listProposals: async (playbookId) => {
      const rows = selectByPlaybook.all(playbookId) as readonly ProposalRow[];
      return rows.map(rowToProposal);
    },
    getEvaluation: async (id) => {
      const row = db
        .query(
          "SELECT id, verdict, metrics, notes, proposal_id, evaluated_at FROM playbook_evaluations WHERE id = ?",
        )
        .get(id) as {
        readonly id: string;
        readonly verdict: string;
        readonly metrics: string;
        readonly notes: string | null;
        readonly proposal_id: string;
        readonly evaluated_at: number;
      } | null;
      if (row === null) return undefined;
      return {
        id: row.id,
        proposalId: row.proposal_id,
        verdict: row.verdict as PlaybookEvaluation["verdict"],
        metrics: JSON.parse(row.metrics) as PlaybookEvaluation["metrics"],
        ...(row.notes !== null ? { notes: row.notes } : {}),
        evaluatedAt: row.evaluated_at,
      };
    },
  };
}

function rowToProposal(row: ProposalRow): PlaybookProposal {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    baseVersion: row.base_version,
    operations: JSON.parse(row.operations) as PlaybookProposal["operations"],
    sourceTrajectoryRange: JSON.parse(
      row.source_trajectory_range,
    ) as PlaybookProposal["sourceTrajectoryRange"],
    reflection: JSON.parse(row.reflection) as PlaybookProposal["reflection"],
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterByTags<T extends { readonly tags: readonly string[] }>(
  rows: readonly T[],
  tags: readonly string[] | undefined,
): readonly T[] {
  if (tags === undefined || tags.length === 0) return rows;
  return rows.filter((r) => tags.every((t) => r.tags.includes(t)));
}
