/**
 * Pure path-builder functions for Nexus event storage layout.
 *
 * Storage layout:
 *   {basePath}/streams/{streamId}/meta.json
 *   {basePath}/streams/{streamId}/events/0000000001.json
 *   {basePath}/subscriptions/{subscriptionName}.json
 *   {basePath}/dead-letters/{entryId}.json
 *
 * Zero I/O, zero dependencies.
 */

const SEQUENCE_DIGITS = 10;

/** Format a sequence number as a zero-padded 10-digit string. */
export function formatSequence(sequence: number): string {
  return String(sequence).padStart(SEQUENCE_DIGITS, "0");
}

/** Path to a stream's metadata file. */
export function streamMetaPath(basePath: string, streamId: string): string {
  return `${basePath}/streams/${streamId}/meta.json`;
}

/** Path to a single event file within a stream. */
export function eventPath(basePath: string, streamId: string, sequence: number): string {
  return `${basePath}/streams/${streamId}/events/${formatSequence(sequence)}.json`;
}

/** Glob pattern matching all event files in a stream. */
export function eventGlobPattern(basePath: string, streamId: string): string {
  return `${basePath}/streams/${streamId}/events/*.json`;
}

/** Path to a subscription position file. */
export function subscriptionPath(basePath: string, subscriptionName: string): string {
  return `${basePath}/subscriptions/${subscriptionName}.json`;
}

/** Path to a dead letter entry file. */
export function deadLetterPath(basePath: string, entryId: string): string {
  return `${basePath}/dead-letters/${entryId}.json`;
}

/** Glob pattern matching all dead letter files. */
export function deadLetterGlobPattern(basePath: string): string {
  return `${basePath}/dead-letters/*.json`;
}
