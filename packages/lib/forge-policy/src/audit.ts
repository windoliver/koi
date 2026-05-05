import type { ForgePolicyVerdict } from "@koi/forge-types";
import type { PolicyOverride } from "./config.js";
import { isAuthenticEvaluation, type PolicyEvaluation } from "./evaluate.js";

/** A single recorded policy decision. */
export interface PolicyAuditEntry {
  readonly candidateId: string;
  /** Post-override verdict — the one the caller acted on. */
  readonly verdict: ForgePolicyVerdict;
  /**
   * Pre-override verdict — what the underlying checks produced before any
   * override was applied. When no override was applied this equals
   * `verdict`. Recording both lets a forensic reader tell exactly which
   * policy rule a granted override bypassed.
   */
  readonly baseVerdict: ForgePolicyVerdict;
  /** Caller-supplied wall-clock timestamp from the originating
   *  evaluation context. Convenience metadata only — NOT a
   *  tamper-resistant ordering signal. Forensic reconstruction must
   *  use `recordedAt` and `sequence`, both bound by the audit log
   *  itself. */
  readonly evaluatedAt: number;
  /** Logger-bound append timestamp (`Date.now()` at the moment the
   *  entry was committed to the buffer). Generated inside the audit
   *  log so a caller cannot backdate a record. */
  readonly recordedAt: number;
  /** Monotonic per-log sequence number. Starts at 0 and increments by
   *  one for every accepted entry, regardless of FIFO eviction.
   *  Tamper-resistant ordering signal — even if `evaluatedAt` /
   *  `recordedAt` collide, sequence numbers do not. */
  readonly sequence: number;
  readonly configFingerprint: string;
  readonly override?: PolicyOverride | undefined;
  /**
   * Whether the override actually relaxed the verdict. When `true`, the
   * recorded `override` is the one that flipped `baseVerdict` →
   * `verdict`. When `false`, the override (if any) was a no-op (e.g. a
   * granted override on an already-allow decision) — preserved for
   * observability so audit consumers can detect override attempts that
   * had no effect.
   */
  readonly overrideApplied: boolean;
  /**
   * Set on fail-closed evaluations only — names which input was
   * rejected (`candidate` / `override` / `config`). `undefined` on
   * normal evaluations. Lives in its own field so audit consumers
   * never have to parse `configFingerprint` to know an entry was a
   * fail-closed deny.
   */
  readonly failureKind?: "candidate" | "override" | "config";
  /**
   * Human-readable detail for `failureKind`. `undefined` on normal
   * evaluations. `configFingerprint` always carries the real policy
   * identity (or the `<unavailable>` sentinel if it could not be
   * computed) — never free-form error text.
   */
  readonly failureReason?: string;
}

/**
 * Inputs for `recordEvaluation` — the safe, fingerprint-binding API.
 * `candidateId`, `override`, and `configFingerprint` are NOT separate
 * parameters: they are read from the authentic `PolicyEvaluation`
 * (bound by `evaluatePolicy` at decision time) so the audit entry is
 * bound to the exact candidate / policy identity that produced the
 * verdict — a caller cannot replay one evaluation against a different
 * candidate id, fingerprint, or override.
 */
export interface RecordEvaluationParams {
  readonly evaluation: PolicyEvaluation;
  readonly evaluatedAt: number;
}

/** Append-only in-memory log of policy decisions. */
export interface PolicyAuditLog {
  /**
   * The only write path. Requires a `PolicyEvaluation` produced by
   * `evaluatePolicy` (verified via a closure-private authenticity
   * brand) so the audit trail cannot record forged
   * fingerprints/overrides/verdicts.
   */
  readonly recordEvaluation: (params: RecordEvaluationParams) => PolicyAuditEntry;
  readonly entries: () => readonly PolicyAuditEntry[];
  readonly size: () => number;
  /**
   * Number of entries that have been evicted by FIFO truncation since
   * the log was created. A non-zero value means at least that many
   * security-relevant decisions are no longer in `entries()` — callers
   * MUST surface this to operators (alert, page, persist to durable
   * sink, etc.) before relying on the in-memory log as a forensic
   * source. Silent eviction would let a flood of benign decisions
   * erase earlier override/deny records; this counter makes that
   * loss observable.
   */
  readonly droppedCount: () => number;
}

/**
 * Validates the shape and cross-field invariants of a `PolicyAuditEntry`.
 * Throws `Error` on any violation. Exported for unit-testing the
 * validator in isolation; production code does NOT reach this — every
 * entry written through `PolicyAuditLog.recordEvaluation` is constructed
 * from a verified `PolicyEvaluation` so the validator never trips at
 * runtime. The leading underscore signals: not part of the public
 * write API, do not call from non-test code.
 */
export function _validatePolicyAuditEntry(entry: PolicyAuditEntryInput): void {
  validateEntry(entry);
}

/**
 * Test-only factory that additionally exposes raw `record(entry)`.
 * Production code MUST use `createPolicyAuditLog`. Implemented as a
 * thin wrapper that delegates `recordEvaluation` to the underlying
 * unsafe-record path.
 */
/**
 * Test-only input shape for the unsafe `record()` path. The audit log
 * binds `recordedAt` and `sequence` itself, so test callers must not
 * supply them — they would just be overwritten. Keeping the input type
 * separate from `PolicyAuditEntry` documents that contract at the type
 * level.
 */
export type PolicyAuditEntryInput = Omit<PolicyAuditEntry, "recordedAt" | "sequence">;

export function _createPolicyAuditLogForTesting(
  options: PolicyAuditLogOptions = {},
): PolicyAuditLog & { readonly record: (entry: PolicyAuditEntryInput) => PolicyAuditEntry } {
  return createPolicyAuditLogInternal(options, true);
}

export interface PolicyAuditLogOptions {
  /** Maximum entries retained — oldest evicted FIFO once exceeded. */
  readonly maxEntries?: number;
  /**
   * Synchronous callback invoked the moment an entry is evicted by
   * FIFO truncation. Receives the dropped entry and the new
   * cumulative `droppedCount`. Wire this to a durable sink (file,
   * database, SIEM, alert) before relying on the in-memory log as a
   * forensic source — once the callback returns, the entry is gone
   * from `entries()`. Throwing from the callback is suppressed so a
   * misconfigured sink cannot crash the policy gate by default. Set
   * `failClosedOnOverflowSinkError: true` to flip this and surface
   * sink failures synchronously.
   */
  readonly onOverflow?: (dropped: PolicyAuditEntry, droppedCount: number) => void;
  /**
   * When `true`, an overflow situation in which there is no
   * `onOverflow` sink (or the sink throws) causes `recordEvaluation`
   * / `record` to throw — the caller MUST treat the throw as a
   * fail-closed signal and stop authorizing decisions while audit
   * retention is degraded. When `false` (default), overflow is
   * best-effort: the entry is evicted and `droppedCount()`
   * accumulates so callers can poll for retention loss. Choose
   * `true` for security-critical deployments where audit trail
   * loss is unacceptable.
   */
  readonly failClosedOnOverflowSinkError?: boolean;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * In-memory audit log. Entries are deep-frozen on insert; reads return a
 * fresh frozen snapshot so later writes do not mutate prior reads. Once
 * `maxEntries` is exceeded the oldest entry is dropped (FIFO).
 */
export function createPolicyAuditLog(options: PolicyAuditLogOptions = {}): PolicyAuditLog {
  return createPolicyAuditLogInternal(options, false);
}

function createPolicyAuditLogInternal(
  options: PolicyAuditLogOptions,
  exposeUnsafeRecord: true,
): PolicyAuditLog & { readonly record: (entry: PolicyAuditEntryInput) => PolicyAuditEntry };
function createPolicyAuditLogInternal(
  options: PolicyAuditLogOptions,
  exposeUnsafeRecord: false,
): PolicyAuditLog;
function createPolicyAuditLogInternal(
  options: PolicyAuditLogOptions,
  exposeUnsafeRecord: boolean,
): PolicyAuditLog & { readonly record?: (entry: PolicyAuditEntryInput) => PolicyAuditEntry } {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`maxEntries must be a positive integer, got ${maxEntries}`);
  }

  const buffer: PolicyAuditEntry[] = [];
  let dropped = 0;
  let nextSequence = 0;

  function record(input: PolicyAuditEntryInput): PolicyAuditEntry {
    validateEntry(input);
    const sequence = nextSequence++;
    const recordedAt = Date.now();
    const full: PolicyAuditEntry = { ...input, recordedAt, sequence };
    const frozen = freezeEntry(full);
    buffer.push(frozen);
    if (buffer.length > maxEntries) {
      const failClosed = options.failClosedOnOverflowSinkError === true;
      const dropEntry = buffer[0];
      // Try the sink BEFORE evicting so a sink failure (or absent
      // sink in fail-closed mode) leaves both the new entry and the
      // would-be-dropped entry intact and signals the caller.
      let sinkOk = false;
      if (dropEntry !== undefined && options.onOverflow !== undefined) {
        try {
          options.onOverflow(dropEntry, dropped + 1);
          sinkOk = true;
        } catch (e) {
          if (failClosed) {
            buffer.pop(); // remove the new entry — caller must retry
            throw new Error(
              "audit overflow sink failed and failClosedOnOverflowSinkError is true",
              { cause: e instanceof Error ? e : new Error(String(e)) },
            );
          }
          // Default: suppress; eviction proceeds regardless.
          sinkOk = true;
        }
      } else if (failClosed) {
        // No sink configured but caller asked to fail closed.
        buffer.pop();
        throw new Error(
          "audit overflow with no onOverflow sink and failClosedOnOverflowSinkError is true",
        );
      } else {
        sinkOk = true;
      }
      if (sinkOk) {
        buffer.shift();
        dropped += 1;
      }
    }
    return frozen;
  }

  function recordEvaluation(params: RecordEvaluationParams): PolicyAuditEntry {
    // Reject fabricated evaluation objects: only objects produced by
    // `evaluatePolicy` are in the authentic-evaluation WeakSet, so a
    // caller cannot hand-craft a structural `PolicyEvaluation` and have
    // it persisted as if it came from a real evaluation.
    if (!isAuthenticEvaluation(params.evaluation)) {
      throw new Error(
        "recordEvaluation requires a PolicyEvaluation produced by evaluatePolicy — fabricated evaluation rejected",
      );
    }
    const input: PolicyAuditEntryInput = {
      candidateId: params.evaluation.candidateId,
      verdict: params.evaluation.verdict,
      baseVerdict: params.evaluation.baseVerdict,
      evaluatedAt: params.evaluatedAt,
      configFingerprint: params.evaluation.configFingerprint,
      override: params.evaluation.override,
      overrideApplied: params.evaluation.overrideApplied,
      ...(params.evaluation.failureKind !== undefined && {
        failureKind: params.evaluation.failureKind,
      }),
      ...(params.evaluation.failureReason !== undefined && {
        failureReason: params.evaluation.failureReason,
      }),
    };
    return record(input);
  }

  function entries(): readonly PolicyAuditEntry[] {
    return Object.freeze(buffer.slice());
  }

  function size(): number {
    return buffer.length;
  }

  function droppedCount(): number {
    return dropped;
  }

  return Object.freeze(
    exposeUnsafeRecord
      ? { recordEvaluation, entries, size, droppedCount, record }
      : { recordEvaluation, entries, size, droppedCount },
  );
}

function validateEntry(entry: PolicyAuditEntryInput): void {
  if (typeof entry.candidateId !== "string" || entry.candidateId.length === 0) {
    throw new Error("PolicyAuditEntry.candidateId must be a non-empty string");
  }
  if (typeof entry.configFingerprint !== "string" || entry.configFingerprint.length === 0) {
    throw new Error("PolicyAuditEntry.configFingerprint must be a non-empty string");
  }
  if (typeof entry.evaluatedAt !== "number" || !Number.isFinite(entry.evaluatedAt)) {
    throw new Error("PolicyAuditEntry.evaluatedAt must be a finite number");
  }
  validateVerdict(entry.verdict);
  validateVerdict(entry.baseVerdict);
  if (entry.override !== undefined) validateOverride(entry.override);
  validateOverrideInvariants(entry);
}

/**
 * Cross-field invariants that keep the audit trail internally consistent:
 *
 *   - When `overrideApplied` is `false`, `verdict` MUST equal
 *     `baseVerdict` — `evaluatePolicy` only sets `overrideApplied:true`
 *     when an override actually relaxed the verdict, so any divergence
 *     here is a forged or stale record. (A granted override that was a
 *     no-op on an already-`allow` decision is recorded with
 *     `overrideApplied:false` and the override metadata preserved.)
 *   - When `overrideApplied` is `true`, `verdict.decision` MUST be
 *     `"allow"`, `baseVerdict.decision` MUST NOT be `"allow"`, and a
 *     granted override MUST be present — overrides only relax
 *     non-`allow` verdicts and never tighten an `allow`.
 */
function validateOverrideInvariants(entry: PolicyAuditEntryInput): void {
  if (!entry.overrideApplied) {
    if (!verdictsEqual(entry.verdict, entry.baseVerdict)) {
      throw new Error(
        "PolicyAuditEntry.verdict must equal baseVerdict when overrideApplied is false",
      );
    }
    // A granted override with overrideApplied:false is only legitimate
    // when the base decision was already `allow` (no relaxation
    // possible). Anything else — granted override paired with a deny
    // or require-approval — is an impossible state that `evaluatePolicy`
    // could not have produced, so reject it as a forged/stale record.
    if (entry.override?.granted === true && entry.verdict.decision !== "allow") {
      throw new Error(
        "PolicyAuditEntry with granted override and overrideApplied:false must have verdict 'allow'",
      );
    }
    return;
  }
  if (entry.override?.granted !== true) {
    throw new Error("PolicyAuditEntry.override.granted must be true when overrideApplied is true");
  }
  if (entry.verdict.decision !== "allow") {
    throw new Error("PolicyAuditEntry.verdict must be 'allow' when overrideApplied is true");
  }
  if (entry.baseVerdict.decision === "allow") {
    throw new Error(
      "PolicyAuditEntry.baseVerdict must not be 'allow' when overrideApplied is true",
    );
  }
}

function verdictsEqual(a: ForgePolicyVerdict, b: ForgePolicyVerdict): boolean {
  if (a.decision !== b.decision) return false;
  if (a.decision === "allow" || b.decision === "allow") return a.decision === b.decision;
  return a.reason === b.reason;
}

function validateVerdict(verdict: ForgePolicyVerdict): void {
  if (verdict.decision === "allow") return;
  if (verdict.decision === "deny" || verdict.decision === "require-approval") {
    if (typeof verdict.reason !== "string" || verdict.reason.length === 0) {
      throw new Error(`PolicyAuditEntry.verdict.reason required for '${verdict.decision}'`);
    }
    return;
  }
  throw new Error("PolicyAuditEntry.verdict.decision is not a known variant");
}

function validateOverride(override: PolicyOverride): void {
  if (typeof override.reason !== "string" || override.reason.length === 0) {
    throw new Error("PolicyOverride.reason must be a non-empty string");
  }
  if (typeof override.grantedBy !== "string" || override.grantedBy.length === 0) {
    throw new Error("PolicyOverride.grantedBy must be a non-empty string");
  }
}

function freezeEntry(entry: PolicyAuditEntry): PolicyAuditEntry {
  const verdict = Object.freeze({ ...entry.verdict });
  const baseVerdict = Object.freeze({ ...entry.baseVerdict });
  const override = entry.override === undefined ? undefined : Object.freeze({ ...entry.override });
  return Object.freeze({
    candidateId: entry.candidateId,
    verdict,
    baseVerdict,
    evaluatedAt: entry.evaluatedAt,
    recordedAt: entry.recordedAt,
    sequence: entry.sequence,
    configFingerprint: entry.configFingerprint,
    override,
    overrideApplied: entry.overrideApplied,
    ...(entry.failureKind !== undefined && { failureKind: entry.failureKind }),
    ...(entry.failureReason !== undefined && { failureReason: entry.failureReason }),
  });
}
