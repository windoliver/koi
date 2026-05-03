/**
 * Nexus-backed SessionStore: write-through local cache with coalesced async
 * writes to Nexus.
 *
 * Read semantics (the durability contract):
 *  - Cache hit → sync return
 *  - Healthy + miss → async Nexus read
 *  - Degraded + miss + probe interval elapsed → one Nexus probe; success
 *    flips back to healthy and serves the value
 *  - Degraded + miss + still cooling down → return EXTERNAL/retryable
 *    rather than NOT_FOUND so callers can distinguish "Nexus unavailable"
 *    from "session truly does not exist"
 *
 * Delete semantics: awaits the remote deletion and surfaces failure via
 * the returned `Result`. The handle's `dispose()` waits for any
 * in-flight deletes so a SIGTERM cannot leave dangling tombstones.
 */

import type { KoiError, Result } from "@koi/core";
import { external, notFound, RETRYABLE_DEFAULTS, validation } from "@koi/core";
import type { Session, SessionStore } from "@koi/gateway-types";
import { extractReadContent, type NexusTransport } from "@koi/nexus-client";
import {
  DEFAULT_BASE_PATH,
  DEFAULT_DEGRADATION_CONFIG,
  type DegradationConfig,
  type GatewayNexusConfig,
} from "./config.js";
import {
  createDegradationState,
  type DegradationState,
  recordFailure,
  recordSuccess,
  shouldProbe,
} from "./degradation.js";
import { createWriteQueue, type WriteQueue } from "./write-queue.js";

interface NexusSessionRecord {
  readonly session: Session;
  readonly ownerInstance: string;
  readonly ownedSince: number;
  readonly version: number;
}

export interface NexusSessionStoreOptions {
  readonly transport: NexusTransport;
  readonly config?: GatewayNexusConfig | undefined;
  /**
   * Optional callback for write-queue background failures (the queued
   * write path is fire-and-forget so the caller never sees those errors
   * via Result). Use this to fail-closed in production wiring.
   */
  readonly onError?: ((err: KoiError) => void) | undefined;
}

export interface NexusSessionStoreHandle {
  readonly store: SessionStore;
  readonly degradation: () => DegradationState;
  readonly dispose: () => Promise<void>;
}

interface StoreInternals {
  readonly transport: NexusTransport;
  readonly basePath: string;
  readonly instanceId: string;
  readonly degradationConfig: DegradationConfig;
  readonly cache: Map<string, Session>;
  readonly inFlightDeletes: Set<Promise<unknown>>;
  readonly getDegradation: () => DegradationState;
  readonly setDegradation: (next: DegradationState) => void;
  readonly enqueueWrite: (session: Session, immediate: boolean) => void;
  /** Tombstone any pending/in-flight writes for this id so a stale queued
   *  write cannot resurrect a record after delete(). */
  readonly cancelWrite: (id: string) => void;
  /** Resolve once any in-flight write for this id has settled. delete()
   *  awaits this before issuing the remote delete so write-then-delete
   *  ordering is preserved at the Nexus layer (even if writeFn succeeded
   *  AFTER delete was called locally). */
  readonly drainWrite: (id: string) => Promise<void>;
}

/**
 * Reversible base64url encoding of the session id so distinct ids never
 * collide on the same Nexus path. Lossy `_`-replacement would let
 * `a/b`, `a b`, and `a_b` overwrite each other and corrupt sequencing
 * state for unrelated sessions.
 */
function nexusPath(basePath: string, id: string): string {
  const enc = Buffer.from(id, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${basePath}/${enc}.json`;
}

function unavailable(id: string): KoiError {
  return external(`Session store unavailable for ${id} (Nexus degraded)`);
}

/**
 * Single-path read via `read_bulk` — bare `read` was removed from the HTTP
 * RPC surface (nexi-lab/nexus#4000) in favor of batch variants. Returns
 * the inner bytes envelope (or undefined when Nexus reports `null` for the
 * path, which is its in-band NOT_FOUND signal).
 */
async function readPath(
  transport: NexusTransport,
  path: string,
): Promise<Result<unknown | undefined, KoiError>> {
  const r = await transport.call<Record<string, unknown> | null>("read_bulk", { paths: [path] });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.value === null || typeof r.value !== "object") return { ok: true, value: undefined };
  // Single-element batch: result key may be the literal request path OR a
  // leading-slash normalized form. Take the first entry rather than literal
  // key lookup.
  const entries = Object.values(r.value);
  const value = entries[0];
  return { ok: true, value: value === null ? undefined : value };
}

async function fetchRemote(s: StoreInternals, id: string): Promise<Result<Session, KoiError>> {
  const path = nexusPath(s.basePath, id);
  const r = await readPath(s.transport, path);
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND") {
      // Don't penalize health for legitimate misses.
      return { ok: false, error: notFound(id, `Session not found: ${id}`) };
    }
    s.setDegradation(recordFailure(s.getDegradation(), s.degradationConfig));
    return { ok: false, error: r.error };
  }
  if (r.value === undefined) {
    s.setDegradation(recordSuccess(s.getDegradation()));
    return { ok: false, error: notFound(id, `Session not found: ${id}`) };
  }
  s.setDegradation(recordSuccess(s.getDegradation()));
  const text = extractReadContent(r.value);
  if (!text.ok) return { ok: false, error: text.error };
  let record: NexusSessionRecord;
  try {
    record = JSON.parse(text.value) as NexusSessionRecord;
  } catch (e: unknown) {
    return { ok: false, error: external(`Malformed session record at ${id}`, e) };
  }
  s.cache.set(id, record.session);
  return { ok: true, value: record.session };
}

/**
 * `delete_batch` returns a per-path object `{path: {success: bool, error?: string}}`
 * rather than a JSON-RPC -32000 NOT_FOUND error. Two response-shape quirks
 * to handle:
 *   1. The result key may be the literal request path OR a leading-slash
 *      normalized form (Nexus stores under `/p` even when written as `p`).
 *      Pick the first entry rather than literal-key lookup.
 *   2. Translate the in-band "File not found" string back to NOT_FOUND so
 *      callers (and the degradation state machine) keep the same semantics
 *      they had under the bare `delete`.
 */
async function deletePath(
  transport: NexusTransport,
  path: string,
): Promise<Result<boolean, KoiError>> {
  const r = await transport.call<Record<string, { success?: boolean; error?: string }>>(
    "delete_batch",
    { paths: [path] },
  );
  if (!r.ok) return { ok: false, error: r.error };
  const obj = r.value !== null && typeof r.value === "object" ? r.value : undefined;
  if (obj === undefined) {
    return { ok: false, error: external(`delete_batch returned no entry for ${path}`) };
  }
  const entries = Object.values(obj);
  const entry = entries[0];
  if (entry === undefined) {
    return { ok: false, error: external(`delete_batch returned empty result for ${path}`) };
  }
  if (entry.success === true) return { ok: true, value: true };
  const msg = entry.error ?? "delete_batch failed";
  if (msg.toLowerCase().includes("not found")) {
    return { ok: false, error: notFound(path, msg) };
  }
  return { ok: false, error: external(msg) };
}

async function deleteRemote(s: StoreInternals, id: string): Promise<Result<boolean, KoiError>> {
  // Cancel queued writes BEFORE draining so an in-flight failed write
  // cannot requeue under the stale value after we tombstone the path
  // server-side. See write-queue tombstone semantics.
  s.cancelWrite(id);
  const existed = s.cache.delete(id);
  // Wait for any in-flight write for this path to settle before issuing
  // the remote delete. Without this, a successful write that started
  // before delete() but lands at Nexus AFTER the delete would resurrect
  // the record (write succeeds → delete succeeds → write-late wins).
  await s.drainWrite(id);
  let r: Result<boolean, KoiError>;
  try {
    r = await deletePath(s.transport, nexusPath(s.basePath, id));
  } catch (e: unknown) {
    s.setDegradation(recordFailure(s.getDegradation(), s.degradationConfig));
    return { ok: false, error: external(`delete failed for ${id}`, e) };
  }
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND") {
      // Already gone — local truth is the cache-existed boolean.
      s.setDegradation(recordSuccess(s.getDegradation()));
      return { ok: true, value: existed };
    }
    s.setDegradation(recordFailure(s.getDegradation(), s.degradationConfig));
    return { ok: false, error: r.error };
  }
  s.setDegradation(recordSuccess(s.getDegradation()));
  return { ok: true, value: existed };
}

function rejectEmptyId(id: string): Result<never, KoiError> | undefined {
  if (id === "") {
    return {
      ok: false,
      error: validation(
        "Session id must not be empty (would alias all empty-id sessions onto one Nexus path)",
      ),
    };
  }
  return undefined;
}

function buildStore(s: StoreInternals): SessionStore {
  return {
    get(id) {
      const reject = rejectEmptyId(id);
      if (reject !== undefined) return reject;
      const cached = s.cache.get(id);
      if (cached !== undefined) return { ok: true, value: cached };
      const deg = s.getDegradation();
      if (deg.mode === "degraded" && !shouldProbe(deg, s.degradationConfig)) {
        return { ok: false, error: unavailable(id) };
      }
      return fetchRemote(s, id);
    },
    set(session) {
      const reject = rejectEmptyId(session.id);
      if (reject !== undefined) return reject;
      const isNew = !s.cache.has(session.id);
      s.cache.set(session.id, session);
      s.enqueueWrite(session, isNew);
      return { ok: true, value: undefined };
    },
    delete(id) {
      const reject = rejectEmptyId(id);
      if (reject !== undefined) return reject;
      const p = deleteRemote(s, id);
      // Track so dispose() can drain in-flight deletes.
      s.inFlightDeletes.add(p);
      return p.finally(() => s.inFlightDeletes.delete(p));
    },
    has(id) {
      if (id === "") return { ok: true, value: false };
      return { ok: true, value: s.cache.has(id) };
    },
    size() {
      return s.cache.size;
    },
    entries() {
      return s.cache.entries() as IterableIterator<readonly [string, Session]>;
    },
  };
}

function makeEnqueue(
  basePath: string,
  instanceId: string,
  queue: WriteQueue,
): (session: Session, immediate: boolean) => void {
  return (session, immediate) => {
    const record: NexusSessionRecord = {
      session,
      ownerInstance: instanceId,
      ownedSince: Date.now(),
      version: 1,
    };
    queue.enqueue(nexusPath(basePath, session.id), JSON.stringify(record), immediate);
  };
}

function reportError(onError: ((e: KoiError) => void) | undefined, err: unknown): void {
  if (onError === undefined) return;
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    onError(err as KoiError);
    return;
  }
  onError({
    code: "EXTERNAL",
    message: err instanceof Error ? err.message : String(err),
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
  });
}

function makeWriteFn(
  transport: NexusTransport,
  degradationConfig: DegradationConfig,
  getDeg: () => DegradationState,
  setDeg: (s: DegradationState) => void,
): (path: string, data: string) => Promise<void> {
  return async (path, data) => {
    // Single-path write via `write_batch` — bare `write` was removed from
    // the HTTP RPC surface (nexi-lab/nexus#4000).
    const r = await transport.call<unknown>("write_batch", {
      files: [[path, { __type__: "bytes", data: Buffer.from(data, "utf-8").toString("base64") }]],
    });
    if (r.ok) {
      setDeg(recordSuccess(getDeg()));
      return;
    }
    setDeg(recordFailure(getDeg(), degradationConfig));
    throw new Error(r.error.message, { cause: r.error });
  };
}

export function createNexusSessionStore(
  options: NexusSessionStoreOptions,
): NexusSessionStoreHandle {
  const { transport, onError } = options;
  const config = options.config ?? {};
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const instanceId = config.instanceId ?? crypto.randomUUID();
  const degradationConfig: DegradationConfig = {
    ...DEFAULT_DEGRADATION_CONFIG,
    ...config.degradation,
  };
  const cache = new Map<string, Session>();
  const inFlightDeletes = new Set<Promise<unknown>>();
  // let justified: degradation state is replaced atomically on every Nexus call.
  let degradation = createDegradationState();
  const getDeg = (): DegradationState => degradation;
  const setDeg = (s: DegradationState): void => {
    degradation = s;
  };

  const queue: WriteQueue = createWriteQueue(
    makeWriteFn(transport, degradationConfig, getDeg, setDeg),
    config.writeQueue,
    (err: unknown) => reportError(onError, err),
  );

  const internals: StoreInternals = {
    transport,
    basePath,
    instanceId,
    degradationConfig,
    cache,
    inFlightDeletes,
    getDegradation: getDeg,
    setDegradation: setDeg,
    enqueueWrite: makeEnqueue(basePath, instanceId, queue),
    cancelWrite: (id: string) => queue.cancel(nexusPath(basePath, id)),
    drainWrite: (id: string) => queue.drainPath(nexusPath(basePath, id)),
  };

  return {
    store: buildStore(internals),
    degradation: () => degradation,
    dispose: async (): Promise<void> => {
      await queue.dispose();
      await Promise.allSettled([...inFlightDeletes]);
    },
  };
}
