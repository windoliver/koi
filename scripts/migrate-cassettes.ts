#!/usr/bin/env bun

/**
 * Migrates cassette fixture files to cassette-v1 format.
 *
 * Changes applied:
 *   1. Adds `schemaVersion: "cassette-v1"` if missing.
 *   2. Strips volatile fields from `done` chunks:
 *      - response.responseId  (changes every recording run)
 *      - response.metadata    (contains promptPrefixFingerprint — volatile)
 *
 * Idempotent: re-running on already-migrated cassettes is a no-op.
 * Self-verifying: validates each output cassette with loadCassette before writing.
 *
 * Usage:
 *   bun run scripts/migrate-cassettes.ts [fixtures-dir]
 *
 * Default fixtures-dir: packages/meta/runtime/fixtures
 */

import { resolve } from "node:path";

const DEFAULT_DIR = resolve(import.meta.dirname, "../packages/meta/runtime/fixtures");
const fixturesDir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DIR;

const files = await Array.fromAsync(
  new Bun.Glob("*.cassette.json").scan({ cwd: fixturesDir, absolute: true }),
);

if (files.length === 0) {
  console.error(`No *.cassette.json files found in ${fixturesDir}`);
  process.exit(1);
}

console.log(`Migrating ${files.length} cassette(s) in ${fixturesDir}...`);

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const filePath of files.sort()) {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  try {
    const raw: unknown = await Bun.file(filePath).json();
    if (typeof raw !== "object" || raw === null) {
      throw new Error("top-level value is not an object");
    }

    const cassette = raw as Record<string, unknown>;
    let changed = false;

    // 1. Add schemaVersion if missing or bump if unknown
    if (cassette.schemaVersion !== "cassette-v1") {
      cassette.schemaVersion = "cassette-v1";
      changed = true;
    }

    // 2. Strip volatile fields from done chunks
    if (Array.isArray(cassette.chunks)) {
      const chunks = cassette.chunks as unknown[];
      for (const chunk of chunks) {
        if (
          typeof chunk === "object" &&
          chunk !== null &&
          (chunk as Record<string, unknown>).kind === "done"
        ) {
          const c = chunk as Record<string, unknown>;
          const response = c.response;
          if (typeof response === "object" && response !== null) {
            const r = response as Record<string, unknown>;
            if ("responseId" in r) {
              delete r.responseId;
              changed = true;
            }
            if ("metadata" in r) {
              delete r.metadata;
              changed = true;
            }
          }
        }
      }
    }

    if (!changed) {
      console.log(`  skip  ${fileName} (already up to date)`);
      skipped++;
      continue;
    }

    // Self-verify: write to temp, parse back, check required fields
    const output = JSON.stringify(cassette, null, 2);
    const reparsed: unknown = JSON.parse(output);
    verifyMigratedCassette(reparsed, fileName);

    await Bun.write(filePath, `${output}\n`);
    console.log(`  migrated  ${fileName}`);
    migrated++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  FAILED  ${fileName}: ${msg}`);
    failed++;
  }
}

console.log(`\nDone: ${migrated} migrated, ${skipped} skipped, ${failed} failed.`);
if (failed > 0) process.exit(1);

function verifyMigratedCassette(data: unknown, fileName: string): void {
  if (typeof data !== "object" || data === null) {
    throw new Error("output is not an object");
  }
  const r = data as Record<string, unknown>;
  if (r.schemaVersion !== "cassette-v1") {
    throw new Error(`schemaVersion is "${String(r.schemaVersion)}", expected "cassette-v1"`);
  }
  if (typeof r.name !== "string") throw new Error('missing "name"');
  if (typeof r.model !== "string") throw new Error('missing "model"');
  if (typeof r.recordedAt !== "number") throw new Error('missing "recordedAt"');
  if (!Array.isArray(r.chunks)) throw new Error('missing "chunks" array');

  // Ensure no volatile fields survived
  for (const chunk of r.chunks as unknown[]) {
    if (typeof chunk === "object" && chunk !== null) {
      const c = chunk as Record<string, unknown>;
      if (c.kind === "done") {
        const response = c.response as Record<string, unknown> | undefined;
        if (response?.responseId !== undefined) {
          throw new Error(`done chunk still has responseId in ${fileName}`);
        }
        if (response?.metadata !== undefined) {
          throw new Error(`done chunk still has metadata in ${fileName}`);
        }
      }
    }
  }
}
