/**
 * Core types for the sanitize middleware.
 */

/**
 * Content block kinds that rules can target.
 * Matches the ContentBlock discriminated union from @koi/core/message.
 */
export type ContentBlockKind = "text" | "file" | "image" | "button" | "custom";

/**
 * Discriminated union describing what to do when a rule matches.
 *
 * - `strip`: Replace the matched text with `replacement` (default: empty string).
 * - `block`: Reject the entire message/request. In streaming output, downgraded to `strip`.
 * - `flag`: Replace with `replacement` and tag the event for observability.
 */
export type SanitizeAction =
  | { readonly kind: "strip"; readonly replacement: string }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "flag"; readonly replacement: string; readonly tag: string };

/** Severity levels for sanitization rules. */
export type SanitizeSeverity = "LOW" | "MEDIUM" | "HIGH";

/**
 * A single sanitization rule — independent from RedactionRule.
 *
 * Each rule has a RegExp pattern that MUST NOT use the `g` flag
 * (patterns are applied via `String.replace` with a fresh match per call).
 */
export interface SanitizeRule {
  readonly name: string;
  /** Pattern to match. Must NOT have the `g` flag — pre-compiled at factory creation. */
  readonly pattern: RegExp;
  readonly action: SanitizeAction;
  /** Block kinds this rule applies to. Default: all block kinds. */
  readonly targets?: readonly ContentBlockKind[];
  readonly severity?: SanitizeSeverity;
}

/** Built-in rule preset identifiers. */
export type RulePreset = "prompt-injection" | "control-chars" | "html-tags" | "zero-width";

/** Location where sanitization occurred — used in callbacks and events. */
export type SanitizationLocation = "input" | "output" | "tool-input" | "tool-output";

/** Event emitted when a sanitization rule fires. */
export interface SanitizationEvent {
  readonly rule: SanitizeRule;
  readonly original: string;
  readonly sanitized: string;
  readonly location: SanitizationLocation;
}
