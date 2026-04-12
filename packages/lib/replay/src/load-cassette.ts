import { isModelChunk } from "@koi/core";
import type { Cassette } from "./types.js";

/**
 * Module-level cache: path → Cassette.
 * Cassette is deeply readonly so sharing across tests is safe.
 * Cache is never invalidated — cassettes are immutable files.
 */
const cache = new Map<string, Cassette>();

/**
 * Loads and validates a cassette from disk, caching the result.
 *
 * Fails fast with a clear error on:
 * - Missing file
 * - Missing or unknown schemaVersion
 * - Missing top-level fields (name, model, recordedAt, chunks)
 * - Malformed chunks (via isModelChunk type guard from @koi/core)
 */
export async function loadCassette(path: string): Promise<Cassette> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Cassette not found: ${path}`);
  }

  const raw: unknown = await file.json();
  const cassette = validateCassette(raw, path);
  cache.set(path, cassette);
  return cassette;
}

/** Clears the cassette cache. Useful in tests that write temp cassettes. */
export function clearCassetteCache(): void {
  cache.clear();
}

function validateCassette(data: unknown, path: string): Cassette {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Invalid cassette at ${path}: expected object, got ${typeof data}`);
  }

  const r = data as Record<string, unknown>;

  if (r.schemaVersion === undefined) {
    throw new Error(
      `Invalid cassette at ${path}: missing "schemaVersion" — run scripts/migrate-cassettes.ts to upgrade`,
    );
  }
  if (r.schemaVersion !== "cassette-v1") {
    throw new Error(
      `Invalid cassette at ${path}: unknown schemaVersion "${String(r.schemaVersion)}" (expected "cassette-v1")`,
    );
  }
  if (typeof r.name !== "string") {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "name" field`);
  }
  if (typeof r.model !== "string") {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "model" field`);
  }
  if (typeof r.recordedAt !== "number") {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "recordedAt" field`);
  }
  if (!Array.isArray(r.chunks)) {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "chunks" array`);
  }

  const chunks = r.chunks as unknown[];
  for (let i = 0; i < chunks.length; i++) {
    if (!isModelChunk(chunks[i])) {
      throw new Error(
        `Invalid cassette at ${path}: chunks[${i}] is not a valid ModelChunk — ` +
          `got kind "${typeof chunks[i] === "object" && chunks[i] !== null ? String((chunks[i] as Record<string, unknown>).kind) : typeof chunks[i]}"`,
      );
    }
  }

  return data as Cassette;
}
