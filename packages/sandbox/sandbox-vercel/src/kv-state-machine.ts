/**
 * Pure-JS port of the spec's Lua `CHECK_OR_CLAIM` / `HEARTBEAT` / `COMMIT` /
 * `FAIL` / `RELEASE` scripts, mirroring the Cloudflare DO state machine but
 * keyed against a Redis-shaped KV instead of DO storage.
 *
 * Lets us validate the state machine against an in-memory mock without
 * pulling in Upstash. Real deploy wires this against Vercel KV via
 * `kvCommand("EVAL", [SCRIPT, ...])` per the spec.
 *
 * Storage layout (keyed under `${ownerId}:`):
 *   ledger:${operationId}     → "${originalDedupeExpiresAtMs}:${fingerprint}"  EX 30d+1h
 *   claim:${operationId}      → requestId                                       EX 15s
 *   result:${operationId}     → JSON                                            EX retentionSec
 *   failed:${operationId}     → JSON                                            EX retentionSec
 *   fingerprint:${operationId}→ fingerprint                                     EX retentionSec
 */

export interface KvCommandRunner {
  readonly get: (key: string) => Promise<string | undefined>;
  readonly setNxEx: (key: string, value: string, ttlSec: number) => Promise<boolean>;
  readonly setEx: (key: string, value: string, ttlSec: number) => Promise<void>;
  readonly del: (key: string) => Promise<number>;
  /** Fluent transactional block — runs atomically against the mock. */
  readonly atomic: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface ClaimRequest {
  readonly ownerId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly dedupeFingerprint: string;
  readonly dedupeExpiresAtMs: number;
  readonly nowMs: number;
  readonly skewToleranceMs?: number;
  readonly leaseTtlSec?: number;
  readonly resultRetentionSec: number;
  readonly ledgerRetentionSec: number;
}

export type ClaimOutcome =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "in-progress";
      readonly claimer: string;
    }
  | { readonly kind: "completed"; readonly result: string }
  | { readonly kind: "failed-permanent"; readonly error: string }
  | { readonly kind: "fingerprint-conflict"; readonly storedFingerprint: string }
  | { readonly kind: "operation-expired" };

const DEFAULT_SKEW_MS = 1_000;
const DEFAULT_LEASE_TTL_SEC = 15;

const keys = (ownerId: string, operationId: string) => ({
  ledger: `${ownerId}:ledger:${operationId}`,
  claim: `${ownerId}:claim:${operationId}`,
  result: `${ownerId}:result:${operationId}`,
  failed: `${ownerId}:failed:${operationId}`,
  fingerprint: `${ownerId}:fingerprint:${operationId}`,
});

const parseLedger = (raw: string): { expiry: number; fingerprint: string } | undefined => {
  const idx = raw.indexOf(":");
  if (idx < 0) return undefined;
  const expiry = Number(raw.slice(0, idx));
  if (!Number.isFinite(expiry)) return undefined;
  return { expiry, fingerprint: raw.slice(idx + 1) };
};

/**
 * Atomic check-or-claim — mirrors the spec's `CHECK_OR_CLAIM_LUA` script.
 *
 * Ledger-first ordering: a present ledger row authoritatively answers expiry
 * + fingerprint mismatch BEFORE any result/failed/claim lookup. On no-ledger,
 * SET-NX writes the ledger atomically; the loser falls back to the ledger
 * branch (matches the production Lua's belt-and-braces double-check).
 */
export const claim = async (kv: KvCommandRunner, req: ClaimRequest): Promise<ClaimOutcome> => {
  const k = keys(req.ownerId, req.operationId);
  const skew = req.skewToleranceMs ?? DEFAULT_SKEW_MS;
  const leaseSec = req.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC;

  return kv.atomic(async () => {
    const ledger = await kv.get(k.ledger);
    if (ledger !== undefined) {
      const parsed = parseLedger(ledger);
      if (parsed === undefined) return { kind: "fingerprint-conflict", storedFingerprint: ledger };
      if (parsed.fingerprint !== req.dedupeFingerprint) {
        return { kind: "fingerprint-conflict", storedFingerprint: parsed.fingerprint };
      }
      if (Math.abs(req.dedupeExpiresAtMs - parsed.expiry) > skew) {
        return { kind: "fingerprint-conflict", storedFingerprint: "EXPIRY_HORIZON_MISMATCH" };
      }
      if (req.nowMs > parsed.expiry) return { kind: "operation-expired" };

      const result = await kv.get(k.result);
      if (result !== undefined) return { kind: "completed", result };
      const failed = await kv.get(k.failed);
      if (failed !== undefined) return { kind: "failed-permanent", error: failed };
      const existing = await kv.get(k.claim);
      if (existing !== undefined) return { kind: "in-progress", claimer: existing };
      // Lease expired or never written — caller becomes new claimer.
      await kv.setEx(k.claim, req.requestId, leaseSec);
      return { kind: "fresh" };
    }

    // No ledger → first-ever claim. Hard-cutoff check before write.
    if (req.nowMs > req.dedupeExpiresAtMs) return { kind: "operation-expired" };
    const ledgerValue = `${req.dedupeExpiresAtMs}:${req.dedupeFingerprint}`;
    const won = await kv.setNxEx(k.ledger, ledgerValue, req.ledgerRetentionSec);
    if (!won) {
      // Lost the SET-NX race — fall back to the ledger branch on the freshly written row.
      const now = await kv.get(k.ledger);
      if (now === undefined)
        return { kind: "fingerprint-conflict", storedFingerprint: "RACE_LOST" };
      const parsed = parseLedger(now);
      if (parsed === undefined) return { kind: "fingerprint-conflict", storedFingerprint: now };
      if (parsed.fingerprint !== req.dedupeFingerprint) {
        return { kind: "fingerprint-conflict", storedFingerprint: parsed.fingerprint };
      }
      if (Math.abs(req.dedupeExpiresAtMs - parsed.expiry) > skew) {
        return { kind: "fingerprint-conflict", storedFingerprint: "EXPIRY_HORIZON_MISMATCH" };
      }
      if (req.nowMs > parsed.expiry) return { kind: "operation-expired" };
      const result = await kv.get(k.result);
      if (result !== undefined) return { kind: "completed", result };
      const failed = await kv.get(k.failed);
      if (failed !== undefined) return { kind: "failed-permanent", error: failed };
      const existing = await kv.get(k.claim);
      if (existing !== undefined) return { kind: "in-progress", claimer: existing };
      await kv.setEx(k.claim, req.requestId, leaseSec);
      return { kind: "fresh" };
    }
    // Ledger SET-NX won — write claim + fingerprint atomically.
    await kv.setEx(k.claim, req.requestId, leaseSec);
    await kv.setEx(k.fingerprint, req.dedupeFingerprint, req.resultRetentionSec);
    return { kind: "fresh" };
  });
};

/** Ownership-checked TTL extension — mirrors `HEARTBEAT_LUA`. */
export const extendLease = async (
  kv: KvCommandRunner,
  ownerId: string,
  operationId: string,
  requestId: string,
  leaseTtlSec: number = DEFAULT_LEASE_TTL_SEC,
): Promise<boolean> => {
  const k = keys(ownerId, operationId);
  return kv.atomic(async () => {
    const owner = await kv.get(k.claim);
    if (owner !== requestId) return false;
    await kv.setEx(k.claim, requestId, leaseTtlSec);
    return true;
  });
};

/** Ownership-checked commit of a successful result — mirrors `COMMIT_LUA`. */
export const commit = async (
  kv: KvCommandRunner,
  ownerId: string,
  operationId: string,
  requestId: string,
  resultJson: string,
  retentionSec: number,
): Promise<boolean> => {
  const k = keys(ownerId, operationId);
  return kv.atomic(async () => {
    const owner = await kv.get(k.claim);
    if (owner !== requestId) return false;
    await kv.setEx(k.result, resultJson, retentionSec);
    await kv.del(k.claim);
    return true;
  });
};

/** Ownership-checked commit of a permanent failure — mirrors `FAIL_LUA`. */
export const commitFail = async (
  kv: KvCommandRunner,
  ownerId: string,
  operationId: string,
  requestId: string,
  errorJson: string,
  retentionSec: number,
): Promise<boolean> => {
  const k = keys(ownerId, operationId);
  return kv.atomic(async () => {
    const owner = await kv.get(k.claim);
    if (owner !== requestId) return false;
    await kv.setEx(k.failed, errorJson, retentionSec);
    await kv.del(k.claim);
    return true;
  });
};

/** Ownership-checked transient release — mirrors `RELEASE_LUA`. */
export const releaseTransient = async (
  kv: KvCommandRunner,
  ownerId: string,
  operationId: string,
  requestId: string,
): Promise<boolean> => {
  const k = keys(ownerId, operationId);
  return kv.atomic(async () => {
    const owner = await kv.get(k.claim);
    if (owner !== requestId) return false;
    await kv.del(k.claim);
    return true;
  });
};
