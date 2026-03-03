/**
 * PII middleware types — detection, strategy, and configuration contracts.
 */

/** A detected PII occurrence in a string. */
export interface PIIMatch {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

/** Unified detector interface — all detectors implement this. */
export interface PIIDetector {
  readonly name: string;
  readonly kind: string;
  readonly detect: (text: string) => readonly PIIMatch[];
}

/** How to handle detected PII. */
export type PIIStrategy = "block" | "redact" | "mask" | "hash";

/** Where to scan for PII. */
export interface PIIScope {
  readonly input?: boolean | undefined;
  readonly output?: boolean | undefined;
  readonly toolResults?: boolean | undefined;
}

/** Factory configuration for createPIIMiddleware. */
export interface PIIConfig {
  readonly strategy: PIIStrategy;
  readonly detectors?: readonly PIIDetector[] | undefined;
  readonly customDetectors?: readonly PIIDetector[] | undefined;
  readonly scope?: PIIScope | undefined;
  readonly hashSecret?: string | undefined;
  readonly onDetection?: ((matches: readonly PIIMatch[], location: string) => void) | undefined;
}
