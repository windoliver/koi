/**
 * Shared parser for the six governance CLI flags introduced by gov-10:
 *
 *   --max-spend <usd>            (non-negative float, USD)
 *   --max-turns <int>            (positive int)
 *   --max-spawn-depth <int>      (positive int)
 *   --policy-file <path>         (path — loaded asynchronously by `policy-file.ts`)
 *   --alert-threshold <pct>      (repeatable float in (0, 1])
 *   --no-governance              (boolean — mutually exclusive with the others)
 *
 * Both `koi start` and `koi tui` expose the same surface by forwarding the
 * parsed raw values through `parseGovernanceFlags`. Keeping the logic in one
 * module prevents the two command parsers from drifting apart on validator
 * messages, conflict rules, or threshold ranges.
 *
 * Async work (reading + validating the `--policy-file` YAML/JSON) lives in
 * `policy-file.ts` and is invoked from the command entry points, not here.
 * Argument parsing stays synchronous so the help/version escape-hatch in
 * `typedParseArgs` keeps working the way every other flag module does.
 */

import { ParseError } from "./shared.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Raw flag values as produced by `typedParseArgs`. The string flavours stay
 * untyped strings so this parser can apply the same numeric validators
 * (`parseIntFlag`-style) that `shared.ts` uses elsewhere. Repeatable
 * `--alert-threshold` comes through as `string[]`.
 */
export interface GovernanceFlagRaw {
  readonly "max-spend": string | undefined;
  readonly "max-turns": string | undefined;
  readonly "max-spawn-depth": string | undefined;
  readonly "policy-file": string | undefined;
  readonly "alert-threshold": readonly string[] | undefined;
  readonly "no-governance": boolean | undefined;
}

/**
 * Fully-resolved governance flag state. `enabled: false` only when the user
 * passed `--no-governance` without any conflicting companion flag. Numeric
 * fields stay `undefined` when the user did not supply the flag so the
 * runtime factory can distinguish "no override" from "zero".
 */
export interface GovernanceFlags {
  readonly enabled: boolean;
  readonly maxSpendUsd: number | undefined;
  readonly maxTurns: number | undefined;
  readonly maxSpawnDepth: number | undefined;
  readonly policyFilePath: string | undefined;
  readonly alertThresholds: readonly number[] | undefined;
}

/**
 * Canonical list of the raw flag keys this module owns. Exported so the
 * per-command option tables stay in sync without re-listing the names.
 */
export const GOVERNANCE_FLAG_NAMES: readonly (keyof GovernanceFlagRaw)[] = Object.freeze([
  "max-spend",
  "max-turns",
  "max-spawn-depth",
  "policy-file",
  "alert-threshold",
  "no-governance",
]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Convert raw `typedParseArgs` output into a validated `GovernanceFlags`.
 *
 * When `skipValidators` is true (help/version escape hatch), bad values
 * silently fall back to "undefined / no override" so callers can still build
 * a shape-complete flags object for the help path. Conflict detection is
 * ALSO skipped in that mode — the user is asking for help, not to run.
 */
export function parseGovernanceFlags(
  raw: GovernanceFlagRaw,
  skipValidators: boolean,
): GovernanceFlags {
  const noGovernance = raw["no-governance"] === true;

  if (!skipValidators && noGovernance) {
    const conflicts: readonly string[] = [
      ...(raw["max-spend"] !== undefined ? ["--max-spend"] : []),
      ...(raw["max-turns"] !== undefined ? ["--max-turns"] : []),
      ...(raw["max-spawn-depth"] !== undefined ? ["--max-spawn-depth"] : []),
      ...(raw["policy-file"] !== undefined ? ["--policy-file"] : []),
      ...((raw["alert-threshold"]?.length ?? 0) > 0 ? ["--alert-threshold"] : []),
    ];
    if (conflicts.length > 0) {
      throw new ParseError(
        `--no-governance cannot be combined with ${conflicts.join(", ")}: ` +
          "explicit disable is mutually exclusive with per-flag overrides. " +
          "Drop --no-governance to apply the overrides, or drop the overrides to disable governance entirely.",
      );
    }
  }

  const maxSpendUsd = resolveMaxSpend(raw["max-spend"], skipValidators);
  const maxTurns = resolvePositiveInt("max-turns", raw["max-turns"], skipValidators);
  const maxSpawnDepth = resolvePositiveInt(
    "max-spawn-depth",
    raw["max-spawn-depth"],
    skipValidators,
  );
  const policyFilePath = resolvePolicyPath(raw["policy-file"], skipValidators);
  const alertThresholds = resolveAlertThresholds(raw["alert-threshold"], skipValidators);

  return {
    enabled: !noGovernance,
    maxSpendUsd,
    maxTurns,
    maxSpawnDepth,
    policyFilePath,
    alertThresholds,
  };
}

/**
 * Manifest-side defaults for the governance flag surface. Shapes mirror
 * `GovernanceFlags` (minus `enabled`) so the merge is a direct field-by-
 * field override. Only the fields present in the manifest are set; the
 * merge skips anything already provided on the CLI.
 */
export interface GovernanceFlagDefaults {
  readonly maxSpendUsd: number | undefined;
  readonly maxTurns: number | undefined;
  readonly maxSpawnDepth: number | undefined;
  readonly policyFilePath: string | undefined;
  readonly alertThresholds: readonly number[] | undefined;
}

/**
 * Overlay manifest defaults on top of the parsed CLI flags. CLI flags win —
 * each field on `flags` that is already set stays as-is, and only undefined
 * fields fall through to `defaults`. `--no-governance` disables everything
 * (manifest values are ignored) so an explicit disable does the same thing
 * whether the manifest had a governance section or not.
 */
export function mergeGovernanceFlags(
  flags: GovernanceFlags,
  defaults: GovernanceFlagDefaults | undefined,
): GovernanceFlags {
  if (!flags.enabled || defaults === undefined) return flags;
  return {
    enabled: flags.enabled,
    maxSpendUsd: flags.maxSpendUsd ?? defaults.maxSpendUsd,
    maxTurns: flags.maxTurns ?? defaults.maxTurns,
    maxSpawnDepth: flags.maxSpawnDepth ?? defaults.maxSpawnDepth,
    policyFilePath: flags.policyFilePath ?? defaults.policyFilePath,
    alertThresholds: flags.alertThresholds ?? defaults.alertThresholds,
  };
}

// ---------------------------------------------------------------------------
// Validators (private)
// ---------------------------------------------------------------------------

function resolveMaxSpend(raw: string | undefined, skip: boolean): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  // Reject trailing junk ("1.5abc" → 1.5) by requiring a clean numeric parse
  // back to the same string. Also reject NaN / Infinity and negatives.
  if (!Number.isFinite(parsed) || parsed < 0 || !MAX_SPEND_RE.test(raw)) {
    if (skip) return undefined;
    throw new ParseError(`--max-spend must be a non-negative finite number (USD), got '${raw}'`);
  }
  return parsed;
}

function resolvePositiveInt(
  name: string,
  raw: string | undefined,
  skip: boolean,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!POSITIVE_INT_RE.test(raw)) {
    if (skip) return undefined;
    throw new ParseError(`--${name} must be a positive integer, got '${raw}'`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    if (skip) return undefined;
    throw new ParseError(`--${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function resolvePolicyPath(raw: string | undefined, skip: boolean): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length === 0) {
    if (skip) return undefined;
    throw new ParseError("--policy-file path cannot be empty");
  }
  return raw;
}

function resolveAlertThresholds(
  raw: readonly string[] | undefined,
  skip: boolean,
): readonly number[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const out: number[] = [];
  for (const entry of raw) {
    const parsed = Number.parseFloat(entry);
    // Thresholds live in (0, 1] — a threshold at 0 would fire on every
    // sample, and a threshold above 1 can never fire (observed ratios are
    // clamped to [0, 1]). Both are user errors rather than silent no-ops.
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1 || !ALERT_THRESHOLD_RE.test(entry)) {
      if (skip) continue;
      throw new ParseError(`--alert-threshold must be a number in (0, 1], got '${entry}'`);
    }
    out.push(parsed);
  }
  if (out.length === 0) return undefined;
  return out;
}

// Strict positive-integer regex: rejects "10abc", "", "0", "-1", "1.5".
const POSITIVE_INT_RE = /^[1-9]\d*$/;

// Non-negative USD amount: digits, optional single fractional part. Matches
// "0", "2", "2.50", "0.01"; rejects "abc", "1.5abc", "--", "", "-1".
const MAX_SPEND_RE = /^\d+(\.\d+)?$/;

// Threshold in (0, 1]. Format-level guard; range is enforced separately so
// "0.00" is rejected at the range check (parses to 0) and "1.5" is rejected
// at the range check (parses above 1).
const ALERT_THRESHOLD_RE = /^\d+(\.\d+)?$/;
