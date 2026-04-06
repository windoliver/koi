/**
 * Configuration validation + defaults for createRedactor().
 */

import type { KoiError, Result } from "@koi/core";
import { createAllSecretPatterns, DEFAULT_SENSITIVE_FIELDS } from "./patterns/index.js";
import { isTrustedPattern } from "./trusted.js";
import type { RedactionConfig, SecretPattern } from "./types.js";

/**
 * Default configuration for createRedactor().
 *
 * Deep-frozen: a caller cannot replace entries in `patterns` (or swap any field
 * on the config object itself) to poison redaction process-wide. Individual
 * pattern objects are already frozen by `markTrusted()`.
 */
export const DEFAULT_REDACTION_CONFIG: RedactionConfig = Object.freeze({
  patterns: Object.freeze(createAllSecretPatterns()),
  customPatterns: Object.freeze([]) as readonly SecretPattern[],
  fieldNames: DEFAULT_SENSITIVE_FIELDS,
  censor: "redact",
  fieldCensor: "redact",
  maxDepth: 10,
  maxStringLength: 100_000,
  onError: undefined,
});

/** Maximum time (ms) allowed for a custom pattern to execute against adversarial input. */
const REDOS_THRESHOLD_MS = 5;

/** Adversarial inputs for ReDoS detection — multiple patterns to catch diverse backtracking triggers. */
const ADVERSARIAL_INPUTS = [
  "a".repeat(50),
  "a]a]a]a]a]a]a]a]a]a]".repeat(5),
  `-----BEGIN a PRIVATE KEY-----${"x".repeat(50)}`,
  `eyJ${".".repeat(50)}`,
] as const;

/**
 * Validate a partial redaction config and merge with defaults.
 * Returns a fully resolved `RedactionConfig` or a validation error.
 */
export function validateRedactionConfig(
  config?: Partial<RedactionConfig>,
): Result<RedactionConfig, KoiError> {
  const raw = config ?? {};

  // Validate maxDepth
  if (raw.maxDepth !== undefined) {
    if (typeof raw.maxDepth !== "number" || raw.maxDepth < 1) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxDepth must be a positive number",
          retryable: false,
        },
      };
    }
  }

  // Validate maxStringLength
  if (raw.maxStringLength !== undefined) {
    if (typeof raw.maxStringLength !== "number" || raw.maxStringLength < 1) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxStringLength must be a positive number",
          retryable: false,
        },
      };
    }
  }

  // Validate censor
  if (raw.censor !== undefined) {
    const c = raw.censor;
    if (typeof c !== "function" && c !== "redact" && c !== "mask" && c !== "remove") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: 'censor must be "redact", "mask", "remove", or a function',
          retryable: false,
        },
      };
    }
  }

  // Validate fieldCensor
  if (raw.fieldCensor !== undefined) {
    const fc = raw.fieldCensor;
    if (typeof fc !== "function" && fc !== "redact" && fc !== "mask" && fc !== "remove") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: 'fieldCensor must be "redact", "mask", "remove", or a function',
          retryable: false,
        },
      };
    }
  }

  // Snapshot user-supplied untrusted patterns into frozen wrappers that capture
  // `name` / `kind` / `detect` by value. Without this, a getter-backed pattern
  // can return a benign `detect` to the probe loop and a slow/throwing one to
  // the runtime — the probe would call a fresh property read each adversarial
  // input and the redactor would later read it again to store its reference.
  // Snapshotting once here closes that gap: the same captured `detect` is
  // probed AND installed into the redactor.
  // Reject non-array containers up front — a proxy/iterable with a throwing
  // `Symbol.iterator` or `next()` would otherwise crash the snapshot loop
  // and escape past the structured VALIDATION result.
  if (raw.patterns !== undefined && !Array.isArray(raw.patterns)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION" as const,
        message: "patterns must be an array",
        retryable: false,
      },
    };
  }
  if (raw.customPatterns !== undefined && !Array.isArray(raw.customPatterns)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION" as const,
        message: "customPatterns must be an array",
        retryable: false,
      },
    };
  }
  const patternsInput = raw.patterns ?? DEFAULT_REDACTION_CONFIG.patterns;
  const customPatternsInput = raw.customPatterns ?? DEFAULT_REDACTION_CONFIG.customPatterns;
  // Snapshot untrusted patterns inside a guarded path — a getter/proxy that
  // throws on property access must produce a structured validation error, not
  // an uncaught exception out of createRedactor().
  const snapshotIfUntrusted = (
    p: SecretPattern,
  ):
    | { readonly ok: true; readonly value: SecretPattern }
    | { readonly ok: false; readonly reason: string } => {
    if (isTrustedPattern(p)) return { ok: true, value: p };
    try {
      const detect = p.detect;
      const name = typeof p.name === "string" ? p.name : "<unnamed>";
      const kind = typeof p.kind === "string" ? p.kind : "<unknown>";
      // Do NOT bind to the caller's object. Both the probe and runtime call
      // `snapshot.detect(text)` with this frozen snapshot as the receiver —
      // the only `this` state a detector ever sees is the immutable
      // `{name, kind}` we captured here. This closes the post-validation
      // state-mutation bypass at the cost of rejecting class-based
      // detectors that read fields beyond `this.name`/`this.kind`: they
      // throw consistently at probe time and surface as a clean VALIDATION
      // error. Stateless function-style detectors are the supported path
      // for custom patterns; use trusted built-ins for full hardening.
      return { ok: true, value: Object.freeze({ name, kind, detect }) };
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason };
    }
  };
  const snapshotAll = (
    list: readonly SecretPattern[],
  ):
    | { readonly ok: true; readonly value: readonly SecretPattern[] }
    | { readonly ok: false; readonly reason: string } => {
    // Outer guard: `Array.isArray` passes `Proxy` arrays, and iteration can
    // still throw via `Symbol.iterator` / indexed-access traps. Treat any
    // container-level throw as a validation failure.
    try {
      const out: SecretPattern[] = [];
      for (const p of list) {
        const r = snapshotIfUntrusted(p);
        if (!r.ok) return { ok: false, reason: r.reason };
        out.push(r.value);
      }
      return { ok: true, value: out };
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason };
    }
  };
  const patternsResult = raw.patterns
    ? snapshotAll(patternsInput)
    : { ok: true as const, value: patternsInput };
  if (!patternsResult.ok) {
    const message = `patterns: property access threw during validation — ${patternsResult.reason}`;
    raw.onError?.(new Error(message));
    return { ok: false, error: { code: "VALIDATION" as const, message, retryable: false } };
  }
  const customPatternsResult = raw.customPatterns
    ? snapshotAll(customPatternsInput)
    : { ok: true as const, value: customPatternsInput };
  if (!customPatternsResult.ok) {
    const message = `customPatterns: property access threw during validation — ${customPatternsResult.reason}`;
    raw.onError?.(new Error(message));
    return { ok: false, error: { code: "VALIDATION" as const, message, retryable: false } };
  }
  const patternsSnap: readonly SecretPattern[] = patternsResult.value;
  const customPatternsSnap: readonly SecretPattern[] = customPatternsResult.value;

  const merged: RedactionConfig = {
    patterns: patternsSnap,
    customPatterns: customPatternsSnap,
    fieldNames: raw.fieldNames ?? DEFAULT_REDACTION_CONFIG.fieldNames,
    censor: raw.censor ?? DEFAULT_REDACTION_CONFIG.censor,
    fieldCensor: raw.fieldCensor ?? DEFAULT_REDACTION_CONFIG.fieldCensor,
    maxDepth: raw.maxDepth ?? DEFAULT_REDACTION_CONFIG.maxDepth,
    maxStringLength: raw.maxStringLength ?? DEFAULT_REDACTION_CONFIG.maxStringLength,
    onError: raw.onError ?? DEFAULT_REDACTION_CONFIG.onError,
  };

  // ReDoS safety check — runs on all user-supplied patterns (fail-closed).
  // Built-in defaults are trusted; only check patterns the caller actually overrides.
  const userSuppliedPatterns: readonly SecretPattern[] = raw.patterns
    ? [...merged.patterns, ...merged.customPatterns]
    : merged.customPatterns;

  for (const pattern of userSuppliedPatterns.filter((p) => !isTrustedPattern(p))) {
    // `pattern` here is the frozen snapshot built above (not the caller's
    // original object), so `pattern.detect` reads a plain data property and
    // cannot re-invoke a getter. Calling via the snapshot preserves the
    // `this` receiver, which detectors written as object methods may rely on.
    if (typeof pattern.detect !== "function") {
      const message = `Pattern "${pattern.name}" has a non-function detect property`;
      merged.onError?.(new Error(message));
      return {
        ok: false,
        error: { code: "VALIDATION" as const, message, retryable: false },
      };
    }
    for (const adversarial of ADVERSARIAL_INPUTS) {
      const start = performance.now();
      let threw = false;
      try {
        pattern.detect(adversarial);
      } catch {
        threw = true;
      }
      // Fail-closed: a detector that throws on probe inputs is rejected.
      // Throwing on the known probe corpus is a trivial bypass — the detector
      // can branch around our fixed inputs and still hang on real traffic.
      if (threw) {
        const message = `Pattern "${pattern.name}" threw an exception on a probe input — detectors must be exception-safe`;
        merged.onError?.(new Error(message));
        return {
          ok: false,
          error: { code: "VALIDATION" as const, message, retryable: false },
        };
      }
      const elapsed = performance.now() - start;
      if (elapsed > REDOS_THRESHOLD_MS) {
        const message = `Pattern "${pattern.name}" took ${elapsed.toFixed(1)}ms on adversarial input — possible ReDoS`;
        merged.onError?.(new Error(message));
        return {
          ok: false,
          error: {
            code: "VALIDATION" as const,
            message,
            retryable: false,
          },
        };
      }
    }
  }

  return { ok: true, value: merged };
}
