import type { ModelChunk } from "@koi/core";

/**
 * Current cassette schema version.
 * Bump to "cassette-v2" when the format gains new top-level fields
 * (e.g. HTTP recordings). Loaders reject unknown versions explicitly.
 */
export type CassetteSchemaVersion = "cassette-v1";
export const CASSETTE_SCHEMA_VERSION: CassetteSchemaVersion = "cassette-v1";

/**
 * A VCR cassette: a recorded sequence of ModelChunks that can be replayed
 * deterministically without API calls.
 *
 * - schemaVersion: guards against loading a v2 cassette with a v1 parser.
 * - model: the model used when recording (for documentation; not enforced at replay).
 * - recordedAt: Unix ms timestamp — informational only, not used for matching.
 * - chunks: the model stream recorded in emission order, volatile fields stripped.
 *
 * Volatile fields stripped at record time: responseId, promptPrefixFingerprint.
 * These differ on every recording of the same query and would cause false diffs.
 */
export interface Cassette {
  readonly schemaVersion: CassetteSchemaVersion;
  readonly name: string;
  readonly model: string;
  readonly recordedAt: number;
  readonly chunks: readonly ModelChunk[];
}
