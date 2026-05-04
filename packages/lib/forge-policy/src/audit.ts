import type { ForgePolicyVerdict } from "@koi/forge-types";
import type { PolicyOverride } from "./config.js";

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
  readonly evaluatedAt: number;
  readonly configFingerprint: string;
  readonly override?: PolicyOverride | undefined;
}

/** Append-only in-memory log of policy decisions. */
export interface PolicyAuditLog {
  readonly record: (entry: PolicyAuditEntry) => void;
  readonly entries: () => readonly PolicyAuditEntry[];
  readonly size: () => number;
}

export interface PolicyAuditLogOptions {
  /** Maximum entries retained — oldest evicted FIFO once exceeded. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * In-memory audit log. Entries are deep-frozen on insert; reads return a
 * fresh frozen snapshot so later writes do not mutate prior reads. Once
 * `maxEntries` is exceeded the oldest entry is dropped (FIFO).
 */
export function createPolicyAuditLog(options: PolicyAuditLogOptions = {}): PolicyAuditLog {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`maxEntries must be a positive integer, got ${maxEntries}`);
  }

  const buffer: PolicyAuditEntry[] = [];

  function record(entry: PolicyAuditEntry): void {
    validateEntry(entry);
    const frozen = freezeEntry(entry);
    buffer.push(frozen);
    if (buffer.length > maxEntries) buffer.shift();
  }

  function entries(): readonly PolicyAuditEntry[] {
    return Object.freeze(buffer.slice());
  }

  function size(): number {
    return buffer.length;
  }

  return Object.freeze({ record, entries, size });
}

function validateEntry(entry: PolicyAuditEntry): void {
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
 *   - Without a granted override, `verdict` MUST equal `baseVerdict` —
 *     `evaluatePolicy` only rewrites the verdict when an override is
 *     granted, so any divergence here is a forged or stale record.
 *   - With a granted override, `verdict.decision` MUST be `"allow"` and
 *     `baseVerdict.decision` MUST NOT be `"allow"` — overrides only
 *     relax non-`allow` verdicts and never tighten an `allow`.
 */
function validateOverrideInvariants(entry: PolicyAuditEntry): void {
  const granted = entry.override?.granted === true;
  if (!granted) {
    if (!verdictsEqual(entry.verdict, entry.baseVerdict)) {
      throw new Error(
        "PolicyAuditEntry.verdict must equal baseVerdict when no override is granted",
      );
    }
    return;
  }
  if (entry.verdict.decision !== "allow") {
    throw new Error("PolicyAuditEntry.verdict must be 'allow' when override.granted is true");
  }
  if (entry.baseVerdict.decision === "allow") {
    throw new Error(
      "PolicyAuditEntry.baseVerdict must not be 'allow' when override.granted is true",
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
    configFingerprint: entry.configFingerprint,
    override,
  });
}
