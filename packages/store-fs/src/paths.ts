/**
 * Hash-shard path computation for filesystem store.
 *
 * Layout: `<baseDir>/<id[0:2]>/<id>.json`
 * Mirrors git's object storage pattern for directory scalability.
 */

import { join } from "node:path";

/** Minimum brick ID length required for shard computation. */
const MIN_ID_LENGTH = 3;

/** Extract the two-character shard prefix from a brick ID. */
export function shardPrefix(id: string): string {
  if (id.length < MIN_ID_LENGTH) {
    return "xx";
  }
  return id.slice(0, 2).toLowerCase();
}

/** Full path to a brick's JSON file: `<baseDir>/<shard>/<id>.json`. */
export function brickPath(baseDir: string, id: string): string {
  return join(baseDir, shardPrefix(id), `${id}.json`);
}

/** Path to a unique temporary file used during atomic writes. */
export function tmpPath(baseDir: string, id: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return join(baseDir, shardPrefix(id), `${id}.${suffix}.tmp`);
}

/** Path to the shard directory for a given brick ID. */
export function shardDir(baseDir: string, id: string): string {
  return join(baseDir, shardPrefix(id));
}
