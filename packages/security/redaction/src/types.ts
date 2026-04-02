/**
 * @koi/redaction — Type definitions for structured log secret masking.
 */

/** A detected secret occurrence within a string value. */
export interface SecretMatch {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

/** Pattern detector — structurally compatible with PIIDetector. */
export interface SecretPattern {
  readonly name: string;
  readonly kind: string;
  readonly detect: (text: string) => readonly SecretMatch[];
}

/** Named censor strategy for replacing detected secrets. */
export type CensorStrategy = "redact" | "mask" | "remove";

/** Censor can be a strategy name or a custom function. */
export type Censor = CensorStrategy | ((match: SecretMatch, fieldName?: string) => string);

/** Configuration for createRedactor(). Immutable after construction. */
export interface RedactionConfig {
  readonly patterns: readonly SecretPattern[];
  readonly customPatterns: readonly SecretPattern[];
  readonly fieldNames: readonly (string | RegExp)[];
  readonly censor: Censor;
  readonly fieldCensor: Censor;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly onError: ((error: unknown) => void) | undefined;
}

/** Result of object redaction. */
export interface RedactObjectResult<T> {
  readonly value: T;
  readonly changed: boolean;
  readonly secretCount: number;
  readonly fieldCount: number;
}

/** Result of string redaction. */
export interface RedactStringResult {
  readonly text: string;
  readonly changed: boolean;
  readonly matchCount: number;
}

/** Compiled redactor — the main API surface. */
export interface Redactor {
  readonly redactObject: <T>(value: T) => RedactObjectResult<T>;
  readonly redactString: (text: string) => RedactStringResult;
}
