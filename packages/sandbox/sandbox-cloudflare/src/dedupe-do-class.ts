/**
 * `KoiDedupeDO` — koi-owned Durable Object class implementing the spec's
 * dedupe state machine. One DO instance per `${ownerId}:${operationId}`,
 * giving us linearisable single-key consistency.
 *
 * Per spec § "Dedupe state machine" + "DO record purge mechanism":
 *
 *   fresh → claimed → completed
 *                 \-> failed-permanent
 *                 \-> claim-expired (lease ran out, reclaimable)
 *
 * The class operates on an injected `DedupeDoStorage` so tests can run it
 * against an in-memory mock and the real deploy can wire it to CF DO storage.
 *
 * Storage layout (one DO instance per (ownerId, operationId)):
 *   ledger        → LedgerRow                       — write-once at first claim
 *   claim         → ClaimRecord | absent            — present only while claimed
 *   terminal      → TerminalRecord | absent         — completed / failed-permanent
 *
 * The alarm is scheduled at `min(terminal.ttlExpiresAt, ledger.ledgerExpiresAtMs)`
 * and fires the two-phase purge (result first, then ledger).
 */

import type {
  ClaimRecord,
  ClaimRequest,
  ClaimStatus,
  CompleteRequest,
  DedupeDoClock,
  DedupeDoConfig,
  DedupeDoStorage,
  FailRequest,
  LedgerRow,
  TerminalRecord,
  WaitForTerminalRequest,
  WaitOutcome,
} from "./dedupe-do-types.js";

const DEFAULT_LEASE_MS = 15_000;
const DEFAULT_SKEW_MS = 1_000;
const DEFAULT_MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const DEFAULT_RESULT_GRACE_MS = 60 * 60 * 1_000; // 1 hour
const LEDGER_GRACE_MS = 60 * 60 * 1_000; // 1 hour beyond the 30-day cap

const KEY_LEDGER = "ledger";
const KEY_CLAIM = "claim";
const KEY_TERMINAL = "terminal";

export interface KoiDedupeDoOptions {
  readonly storage: DedupeDoStorage;
  readonly clock: DedupeDoClock;
  readonly config?: DedupeDoConfig;
  /**
   * Sleep injection for `waitForTerminal`. Defaults to wall-clock `setTimeout`
   * in production. Tests inject a stub that advances a fake clock so timeouts
   * are deterministic.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

const computeAlarmAt = (
  terminalTtl: number | undefined,
  ledgerExpiry: number | undefined,
): number | null => {
  const candidates: number[] = [];
  if (terminalTtl !== undefined) candidates.push(terminalTtl);
  if (ledgerExpiry !== undefined) candidates.push(ledgerExpiry);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class KoiDedupeDO {
  readonly #storage: DedupeDoStorage;
  readonly #clock: DedupeDoClock;
  readonly #leaseMs: number;
  readonly #skewMs: number;
  readonly #maxHorizonMs: number;
  readonly #resultGraceMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: KoiDedupeDoOptions) {
    this.#storage = opts.storage;
    this.#clock = opts.clock;
    this.#leaseMs = opts.config?.leaseDurationMs ?? DEFAULT_LEASE_MS;
    this.#skewMs = opts.config?.skewToleranceMs ?? DEFAULT_SKEW_MS;
    this.#maxHorizonMs = opts.config?.maxDedupeHorizonMs ?? DEFAULT_MAX_HORIZON_MS;
    this.#resultGraceMs = opts.config?.resultGraceMs ?? DEFAULT_RESULT_GRACE_MS;
    this.#sleep = opts.sleep ?? sleep;
  }

  async claim(req: ClaimRequest): Promise<ClaimStatus> {
    return this.#storage.transaction(async (s) => {
      const now = this.#clock.nowMs();
      const ledger = await s.get<LedgerRow>(KEY_LEDGER);

      // Ledger-first ordering: a present ledger row authoritatively answers
      // expiry and fingerprint mismatch BEFORE we look at any result/claim.
      if (ledger !== undefined) {
        if (ledger.originalDedupeFingerprint !== req.dedupeFingerprint) {
          return {
            status: "fingerprint-conflict",
            storedFingerprint: ledger.originalDedupeFingerprint,
          };
        }
        if (Math.abs(req.dedupeExpiresAtMs - ledger.originalDedupeExpiresAtMs) > this.#skewMs) {
          return {
            status: "fingerprint-conflict",
            storedFingerprint: "EXPIRY_HORIZON_MISMATCH",
          };
        }
        if (now > ledger.originalDedupeExpiresAtMs) {
          return {
            status: "operation-expired",
            originalDedupeExpiresAtMs: ledger.originalDedupeExpiresAtMs,
          };
        }

        const terminal = await s.get<TerminalRecord>(KEY_TERMINAL);
        if (terminal !== undefined) {
          return terminal.kind === "completed"
            ? { status: "completed", result: terminal.result, statusCode: terminal.statusCode }
            : { status: "failed-permanent", error: terminal.error };
        }

        const existingClaim = await s.get<ClaimRecord>(KEY_CLAIM);
        if (existingClaim !== undefined && existingClaim.leaseUntil > now) {
          return {
            status: "in-progress",
            claimer: existingClaim.claimer,
            leaseUntil: existingClaim.leaseUntil,
          };
        }
        // Lease expired or missing — caller becomes the new claimer.
        await this.#writeFreshClaim(s, req, now);
        return { status: "fresh" };
      }

      // No ledger yet → first-ever claim. Validate hard horizon, then write
      // ledger + claim atomically.
      if (req.dedupeExpiresAtMs > now + this.#maxHorizonMs) {
        return {
          status: "fingerprint-conflict",
          storedFingerprint: "INVALID_DEDUPE_HORIZON",
        };
      }
      if (now > req.dedupeExpiresAtMs) {
        return {
          status: "operation-expired",
          originalDedupeExpiresAtMs: req.dedupeExpiresAtMs,
        };
      }

      const ledgerRow: LedgerRow = {
        firstClaimAtMs: now,
        originalDedupeExpiresAtMs: req.dedupeExpiresAtMs,
        originalDedupeFingerprint: req.dedupeFingerprint,
        ledgerExpiresAtMs: now + this.#maxHorizonMs + LEDGER_GRACE_MS,
      };
      const claimRecord: ClaimRecord = {
        claimer: req.requestId,
        claimedAt: now,
        leaseUntil: now + this.#leaseMs,
        dedupeFingerprint: req.dedupeFingerprint,
      };
      await s.put({ [KEY_LEDGER]: ledgerRow, [KEY_CLAIM]: claimRecord });

      // Schedule alarm for ledger purge — terminal alarm gets re-scheduled at
      // commit time when its TTL becomes known.
      await this.#rescheduleAlarm(s);
      return { status: "fresh" };
    });
  }

  async complete(req: CompleteRequest): Promise<{ committed: boolean; reason?: string }> {
    return this.#storage.transaction(async (s) => {
      const now = this.#clock.nowMs();
      const claim = await s.get<ClaimRecord>(KEY_CLAIM);
      if (claim === undefined) return { committed: false, reason: "OWNERSHIP_LOST" };
      if (claim.claimer !== req.requestId) return { committed: false, reason: "OWNERSHIP_LOST" };
      if (claim.dedupeFingerprint !== req.dedupeFingerprint) {
        return { committed: false, reason: "FINGERPRINT_MISMATCH" };
      }

      const terminal: TerminalRecord = {
        kind: "completed",
        result: req.result,
        statusCode: req.statusCode,
        completedAt: now,
        ttlExpiresAt: req.ttlExpiresAtMs,
        dedupeFingerprint: req.dedupeFingerprint,
      };
      await s.put({ [KEY_TERMINAL]: terminal });
      await s.delete([KEY_CLAIM]);
      await this.#rescheduleAlarm(s);
      return { committed: true };
    });
  }

  async fail(req: FailRequest): Promise<{ committed: boolean; reason?: string }> {
    return this.#storage.transaction(async (s) => {
      const now = this.#clock.nowMs();
      const claim = await s.get<ClaimRecord>(KEY_CLAIM);
      if (claim === undefined) return { committed: false, reason: "OWNERSHIP_LOST" };
      if (claim.claimer !== req.requestId) return { committed: false, reason: "OWNERSHIP_LOST" };
      if (claim.dedupeFingerprint !== req.dedupeFingerprint) {
        return { committed: false, reason: "FINGERPRINT_MISMATCH" };
      }

      const terminal: TerminalRecord = {
        kind: "failed-permanent",
        error: req.error,
        failedAt: now,
        ttlExpiresAt: req.ttlExpiresAtMs,
        dedupeFingerprint: req.dedupeFingerprint,
      };
      await s.put({ [KEY_TERMINAL]: terminal });
      await s.delete([KEY_CLAIM]);
      await this.#rescheduleAlarm(s);
      return { committed: true };
    });
  }

  async waitForTerminal(req: WaitForTerminalRequest): Promise<WaitOutcome> {
    const start = this.#clock.nowMs();
    const pollMs = req.pollIntervalMs ?? 1_000;
    while (this.#clock.nowMs() - start < req.timeoutMs) {
      const probe = await this.#pollOnce(req);
      if (probe !== null) return probe;
      await this.#sleep(pollMs);
    }
    return { kind: "timeout" };
  }

  /** Two-phase alarm purge — result records first, then ledger rows. */
  async alarm(): Promise<void> {
    await this.#storage.transaction(async (s) => {
      const now = this.#clock.nowMs();
      const terminal = await s.get<TerminalRecord>(KEY_TERMINAL);
      const ledger = await s.get<LedgerRow>(KEY_LEDGER);

      if (terminal !== undefined && terminal.ttlExpiresAt < now) {
        await s.delete([KEY_TERMINAL]);
      }
      if (ledger !== undefined && ledger.ledgerExpiresAtMs < now) {
        await s.delete([KEY_LEDGER]);
      }
      await this.#rescheduleAlarm(s);
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async #writeFreshClaim(s: DedupeDoStorage, req: ClaimRequest, now: number): Promise<void> {
    const claim: ClaimRecord = {
      claimer: req.requestId,
      claimedAt: now,
      leaseUntil: now + this.#leaseMs,
      dedupeFingerprint: req.dedupeFingerprint,
    };
    await s.put({ [KEY_CLAIM]: claim });
  }

  async #pollOnce(req: WaitForTerminalRequest): Promise<WaitOutcome | null> {
    return this.#storage.transaction(async (s) => {
      const now = this.#clock.nowMs();
      const ledger = await s.get<LedgerRow>(KEY_LEDGER);
      if (ledger === undefined) {
        // Ledger has been purged or never existed — treat as expired.
        return { kind: "operation-expired", originalDedupeExpiresAtMs: 0 };
      }
      if (Math.abs(req.requestExpiryClaim - ledger.originalDedupeExpiresAtMs) > this.#skewMs) {
        return {
          kind: "operation-id-conflict",
          storedFingerprint: "EXPIRY_HORIZON_MISMATCH",
        };
      }
      if (now > ledger.originalDedupeExpiresAtMs) {
        return {
          kind: "operation-expired",
          originalDedupeExpiresAtMs: ledger.originalDedupeExpiresAtMs,
        };
      }
      const terminal = await s.get<TerminalRecord>(KEY_TERMINAL);
      if (terminal === undefined) return null;
      return terminal.kind === "completed"
        ? { kind: "completed", result: terminal.result }
        : { kind: "failed-permanent", error: terminal.error };
    });
  }

  async #rescheduleAlarm(s: DedupeDoStorage): Promise<void> {
    const ledger = await s.get<LedgerRow>(KEY_LEDGER);
    const terminal = await s.get<TerminalRecord>(KEY_TERMINAL);
    const next = computeAlarmAt(terminal?.ttlExpiresAt, ledger?.ledgerExpiresAtMs);
    if (next === null) return;
    await s.setAlarm(next);
  }

  /** Compute spec-mandated TTL for a terminal record. */
  ttlExpiresAtMsFor(req: { dedupeExpiresAtMs: number }): number {
    return req.dedupeExpiresAtMs + this.#resultGraceMs;
  }
}
