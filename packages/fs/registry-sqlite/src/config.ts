/**
 * Shared configuration for registry-sqlite factories.
 *
 * Resolves a Database instance from either a file path or an injected Database.
 * Caller owns lifecycle when injecting; factory owns it when creating from path.
 */

import type { Database } from "bun:sqlite";
import { openDb } from "@koi/sqlite-utils";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface RegistrySqlitePathConfig {
  readonly dbPath: string;
}

export interface RegistrySqliteDbConfig {
  readonly db: Database;
}

export type RegistrySqliteConfig = RegistrySqlitePathConfig | RegistrySqliteDbConfig;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function isPathConfig(config: RegistrySqliteConfig): config is RegistrySqlitePathConfig {
  return "dbPath" in config;
}

export interface ResolvedDb {
  readonly db: Database;
  readonly ownsDb: boolean;
}

/** Resolve a Database from config. Returns ownership flag for close() logic. */
export function resolveDb(config: RegistrySqliteConfig): ResolvedDb {
  if (isPathConfig(config)) {
    return { db: openDb(config.dbPath), ownsDb: true };
  }
  return { db: config.db, ownsDb: false };
}
