/**
 * SQLite-backed SkillRegistry implementation.
 *
 * Two-table design: `skills` for catalog entries + `skill_versions` for
 * version-specific content. FTS5 for search, junction table for tags.
 */

import type { Database } from "bun:sqlite";
import type {
  BrickRequires,
  ForgeProvenance,
  KoiError,
  Result,
  SkillArtifact,
  SkillId,
  SkillPage,
  SkillPublishRequest,
  SkillRegistryBackend,
  SkillRegistryChangeEvent,
  SkillRegistryEntry,
  SkillSearchQuery,
  SkillVersion,
} from "@koi/core";
import { brickId, conflict, DEFAULT_SKILL_SEARCH_LIMIT, notFound, validation } from "@koi/core";
import { wrapSqlite } from "@koi/sqlite-utils";
import type { RegistryStoreConfig } from "./config.js";
import { resolveDb } from "./config.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { sanitizeFtsQuery } from "./fts-sanitize.js";
import { createListenerSet } from "./listeners.js";
import { applyRegistryMigrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface SkillRow {
  readonly rowid: number;
  readonly skill_id: string;
  readonly name: string;
  readonly description: string;
  readonly author: string | null;
  readonly requires: string | null;
  readonly published_at: number;
  readonly downloads: number;
}

interface VersionRow {
  readonly rowid: number;
  readonly skill_rowid: number;
  readonly version: string;
  readonly content: string;
  readonly integrity: string | null;
  readonly published_at: number;
  readonly deprecated: number;
}

interface CountRow {
  readonly cnt: number;
}

// ---------------------------------------------------------------------------
// Default provenance for registry-installed skills
// ---------------------------------------------------------------------------

const REGISTRY_PROVENANCE: ForgeProvenance = {
  source: { origin: "external", registry: "koi-registry-store", packageRef: "local" },
  buildDefinition: {
    buildType: "koi.registry/skill/v1",
    externalParameters: {},
  },
  builder: { id: "koi.registry/install/v1", version: "0.0.0" },
  metadata: {
    invocationId: "registry-install",
    startedAt: 0,
    finishedAt: 0,
    sessionId: "registry",
    agentId: "registry",
    depth: 0,
  },
  verification: {
    passed: true,
    finalTrustTier: "sandbox",
    totalDurationMs: 0,
    stageResults: [],
  },
  classification: "public",
  contentMarkers: [],
  contentHash: "",
};

// ---------------------------------------------------------------------------
// Search filter builder
// ---------------------------------------------------------------------------

interface FilterClause {
  readonly parts: readonly string[];
  readonly params: readonly (string | number)[];
}

/** Build WHERE filter parts for skill search (without cursor). */
function buildSkillFilter(db: Database, query: SkillSearchQuery): FilterClause | null {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  if (query.text !== undefined && query.text.trim() !== "") {
    const sanitized = sanitizeFtsQuery(query.text);
    if (sanitized !== "") {
      const ftsRows = db
        .query<{ rowid: number }, [string]>("SELECT rowid FROM skills_fts WHERE skills_fts MATCH ?")
        .all(sanitized);
      if (ftsRows.length === 0) return null;
      parts.push(`s.rowid IN (${ftsRows.map((r) => r.rowid).join(",")})`);
    }
  }

  if (query.tags !== undefined && query.tags.length > 0) {
    const placeholders = query.tags.map(() => "?").join(", ");
    parts.push(
      `(SELECT COUNT(DISTINCT t.tag) FROM skill_tags t
        WHERE t.skill_rowid = s.rowid AND t.tag IN (${placeholders})) = ?`,
    );
    for (const tag of query.tags) {
      params.push(tag);
    }
    params.push(query.tags.length);
  }

  if (query.author !== undefined) {
    parts.push("s.author = ?");
    params.push(query.author);
  }

  return { parts, params };
}

// ---------------------------------------------------------------------------
// Batch tag loading (avoids N+1)
// ---------------------------------------------------------------------------

function loadTagsByRowids(
  db: Database,
  rowids: readonly number[],
): ReadonlyMap<number, readonly string[]> {
  if (rowids.length === 0) return new Map();
  const placeholders = rowids.map(() => "?").join(",");
  const rows = db
    .prepare<{ skill_rowid: number; tag: string }, number[]>(
      `SELECT skill_rowid, tag FROM skill_tags WHERE skill_rowid IN (${placeholders})`,
    )
    .all(...rowids);
  const map = new Map<number, string[]>();
  for (const r of rows) {
    const existing = map.get(r.skill_rowid);
    if (existing !== undefined) {
      existing.push(r.tag);
    } else {
      map.set(r.skill_rowid, [r.tag]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqliteSkillRegistry extends SkillRegistryBackend {
  readonly close: () => void;
}

export function createSqliteSkillRegistry(config: RegistryStoreConfig): SqliteSkillRegistry {
  const { db, ownsDb } = resolveDb(config);
  applyRegistryMigrations(db);

  const listeners = createListenerSet<SkillRegistryChangeEvent>();

  // -------------------------------------------------------------------------
  // FTS helpers
  // -------------------------------------------------------------------------

  function insertFts(
    rowid: number,
    name: string,
    description: string,
    tags: readonly string[],
  ): void {
    db.run("INSERT INTO skills_fts(rowid, name, description, tags) VALUES (?, ?, ?, ?)", [
      rowid,
      name,
      description,
      tags.join(" "),
    ]);
  }

  function deleteFts(rowid: number): void {
    db.run(
      "INSERT INTO skills_fts(skills_fts, rowid, name, description, tags) VALUES ('delete', ?, '', '', '')",
      [rowid],
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function isBlank(s: string): boolean {
    return s.trim() === "";
  }

  function loadEntry(row: SkillRow, tags: readonly string[]): SkillRegistryEntry {
    const latestVer = db
      .query<{ version: string }, [number]>(
        `SELECT version FROM skill_versions
         WHERE skill_rowid = ? ORDER BY published_at DESC, rowid DESC LIMIT 1`,
      )
      .get(row.rowid);

    const base: SkillRegistryEntry = {
      id: row.skill_id as SkillId,
      name: row.name,
      description: row.description,
      tags,
      version: latestVer?.version ?? "",
      publishedAt: row.published_at,
    };

    return {
      ...base,
      ...(row.author !== null ? { author: row.author } : {}),
      ...(row.requires !== null ? { requires: JSON.parse(row.requires) as BrickRequires } : {}),
      ...(row.downloads > 0 ? { downloads: row.downloads } : {}),
    };
  }

  function getTagsForSkill(skillRowid: number): readonly string[] {
    const rows = db
      .query<{ tag: string }, [number]>("SELECT tag FROM skill_tags WHERE skill_rowid = ?")
      .all(skillRowid);
    return rows.map((r) => r.tag);
  }

  // -------------------------------------------------------------------------
  // Contract: publish
  // -------------------------------------------------------------------------

  const publish = (request: SkillPublishRequest): Result<SkillRegistryEntry, KoiError> => {
    if (isBlank(request.name)) {
      return { ok: false, error: validation("Skill name must not be empty") };
    }
    if (isBlank(request.version)) {
      return { ok: false, error: validation("Skill version must not be empty") };
    }

    const existing = db
      .query<SkillRow, [string]>("SELECT * FROM skills WHERE skill_id = ?")
      .get(request.id as string);

    return existing !== null ? publishNewVersion(request, existing) : publishNewSkill(request);
  };

  function publishNewVersion(
    request: SkillPublishRequest,
    existing: SkillRow,
  ): Result<SkillRegistryEntry, KoiError> {
    const dupVer = db
      .query<{ rowid: number }, [number, string]>(
        "SELECT rowid FROM skill_versions WHERE skill_rowid = ? AND version = ?",
      )
      .get(existing.rowid, request.version);

    if (dupVer !== null) {
      return {
        ok: false,
        error: conflict(
          request.id as string,
          `Version ${request.version} already exists for skill ${request.id}`,
        ),
      };
    }

    const now = Date.now();
    const result = wrapSqlite(() => {
      db.transaction(() => {
        db.run(
          `UPDATE skills SET name = ?, description = ?, author = ?,
           requires = ?, published_at = ? WHERE rowid = ?`,
          [
            request.name,
            request.description,
            request.author ?? null,
            request.requires !== undefined ? JSON.stringify(request.requires) : null,
            now,
            existing.rowid,
          ],
        );
        db.run("DELETE FROM skill_tags WHERE skill_rowid = ?", [existing.rowid]);
        for (const tag of request.tags) {
          db.run("INSERT INTO skill_tags (skill_rowid, tag) VALUES (?, ?)", [existing.rowid, tag]);
        }
        db.run(
          `INSERT INTO skill_versions (skill_rowid, version, content, integrity, published_at)
           VALUES (?, ?, ?, ?, ?)`,
          [existing.rowid, request.version, request.content, request.integrity ?? null, now],
        );
        deleteFts(existing.rowid);
        insertFts(existing.rowid, request.name, request.description, request.tags);
      })();
    }, "skill.publish");

    if (!result.ok) return result;
    listeners.notify({ kind: "published", skillId: request.id, version: request.version });

    const updatedRow = db
      .query<SkillRow, [string]>("SELECT * FROM skills WHERE skill_id = ?")
      .get(request.id as string);
    if (updatedRow === null) return { ok: false, error: notFound(request.id as string) };
    return { ok: true, value: loadEntry(updatedRow, [...request.tags]) };
  }

  function publishNewSkill(request: SkillPublishRequest): Result<SkillRegistryEntry, KoiError> {
    const now = Date.now();
    const result = wrapSqlite(() => {
      db.transaction(() => {
        db.run(
          `INSERT INTO skills (skill_id, name, description, author, requires, published_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            request.id as string,
            request.name,
            request.description,
            request.author ?? null,
            request.requires !== undefined ? JSON.stringify(request.requires) : null,
            now,
          ],
        );
        const inserted = db
          .query<{ rowid: number }, [string]>("SELECT rowid FROM skills WHERE skill_id = ?")
          .get(request.id as string);
        const newRowid = inserted?.rowid ?? 0;
        for (const tag of request.tags) {
          db.run("INSERT INTO skill_tags (skill_rowid, tag) VALUES (?, ?)", [newRowid, tag]);
        }
        db.run(
          `INSERT INTO skill_versions (skill_rowid, version, content, integrity, published_at)
           VALUES (?, ?, ?, ?, ?)`,
          [newRowid, request.version, request.content, request.integrity ?? null, now],
        );
        insertFts(newRowid, request.name, request.description, request.tags);
      })();
    }, "skill.publish");

    if (!result.ok) return result;
    listeners.notify({ kind: "published", skillId: request.id, version: request.version });

    const newRow = db
      .query<SkillRow, [string]>("SELECT * FROM skills WHERE skill_id = ?")
      .get(request.id as string);
    if (newRow === null) return { ok: false, error: notFound(request.id as string) };
    return { ok: true, value: loadEntry(newRow, [...request.tags]) };
  }

  // -------------------------------------------------------------------------
  // Contract: search
  // -------------------------------------------------------------------------

  const search = (query: SkillSearchQuery): SkillPage => {
    const limit = query.limit ?? DEFAULT_SKILL_SEARCH_LIMIT;
    const filter = buildSkillFilter(db, query);
    if (filter === null) return { items: [], total: 0 };

    const filterWhere = filter.parts.length > 0 ? `WHERE ${filter.parts.join(" AND ")}` : "";
    const countRow = db
      .prepare<CountRow, (string | number)[]>(`SELECT COUNT(*) as cnt FROM skills s ${filterWhere}`)
      .get(...filter.params);
    const total = countRow?.cnt ?? 0;

    const pageParts = [...filter.parts];
    const pageParams: (string | number)[] = [...filter.params];
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      if (decoded !== undefined) {
        pageParts.push("(s.published_at < ? OR (s.published_at = ? AND s.rowid < ?))");
        pageParams.push(decoded.sortKey, decoded.sortKey, decoded.rowid);
      }
    }

    const pageWhere = pageParts.length > 0 ? `WHERE ${pageParts.join(" AND ")}` : "";
    const rows = db
      .prepare<SkillRow, (string | number)[]>(
        `SELECT s.* FROM skills s ${pageWhere}
         ORDER BY s.published_at DESC, s.rowid DESC LIMIT ?`,
      )
      .all(...pageParams, limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const tagMap = loadTagsByRowids(
      db,
      pageRows.map((r) => r.rowid),
    );
    const items = pageRows.map((r) => loadEntry(r, tagMap.get(r.rowid) ?? []));

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined
        ? encodeCursor(lastRow.published_at, lastRow.rowid)
        : undefined;
    const base = { items, total };
    return nextCursor !== undefined ? { ...base, cursor: nextCursor } : base;
  };

  // -------------------------------------------------------------------------
  // Contract: get
  // -------------------------------------------------------------------------

  const get = (id: SkillId): Result<SkillRegistryEntry, KoiError> => {
    const row = db
      .query<SkillRow, [string]>("SELECT * FROM skills WHERE skill_id = ?")
      .get(id as string);

    if (row === null) {
      return { ok: false, error: notFound(id as string, `Skill not found: ${id}`) };
    }

    return { ok: true, value: loadEntry(row, getTagsForSkill(row.rowid)) };
  };

  // -------------------------------------------------------------------------
  // Contract: versions
  // -------------------------------------------------------------------------

  const versions = (id: SkillId): Result<readonly SkillVersion[], KoiError> => {
    const skill = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM skills WHERE skill_id = ?")
      .get(id as string);

    if (skill === null) {
      return { ok: false, error: notFound(id as string, `Skill not found: ${id}`) };
    }

    const rows = db
      .query<VersionRow, [number]>(
        `SELECT * FROM skill_versions
         WHERE skill_rowid = ? ORDER BY published_at DESC, rowid DESC`,
      )
      .all(skill.rowid);

    const result: readonly SkillVersion[] = rows.map((r) => {
      const base: SkillVersion = { version: r.version, publishedAt: r.published_at };
      const withIntegrity = r.integrity !== null ? { ...base, integrity: r.integrity } : base;
      return r.deprecated === 1 ? { ...withIntegrity, deprecated: true } : withIntegrity;
    });

    return { ok: true, value: result };
  };

  // -------------------------------------------------------------------------
  // Contract: install (async satisfies L0 contract — this impl is sync)
  // -------------------------------------------------------------------------

  const install = async (
    id: SkillId,
    version?: string,
  ): Promise<Result<SkillArtifact, KoiError>> => {
    const skill = db
      .query<SkillRow, [string]>("SELECT * FROM skills WHERE skill_id = ?")
      .get(id as string);

    if (skill === null) {
      return { ok: false, error: notFound(id as string, `Skill not found: ${id}`) };
    }

    const versionRow =
      version !== undefined
        ? db
            .query<VersionRow, [number, string]>(
              "SELECT * FROM skill_versions WHERE skill_rowid = ? AND version = ?",
            )
            .get(skill.rowid, version)
        : db
            .query<VersionRow, [number]>(
              `SELECT * FROM skill_versions WHERE skill_rowid = ?
           ORDER BY published_at DESC, rowid DESC LIMIT 1`,
            )
            .get(skill.rowid);

    if (versionRow === null) {
      return {
        ok: false,
        error: notFound(id as string, `Version not found: ${version ?? "latest"}`),
      };
    }

    db.run("UPDATE skills SET downloads = downloads + 1 WHERE rowid = ?", [skill.rowid]);

    const artifact: SkillArtifact = {
      id: brickId(id as string),
      kind: "skill",
      name: skill.name,
      description: skill.description,
      scope: "global",
      trustTier: "sandbox",
      lifecycle: "active",
      provenance: REGISTRY_PROVENANCE,
      version: versionRow.version,
      tags: [...getTagsForSkill(skill.rowid)],
      usageCount: 0,
      content: versionRow.content,
    };

    return { ok: true, value: artifact };
  };

  // -------------------------------------------------------------------------
  // Contract: unpublish
  // -------------------------------------------------------------------------

  const unpublish = (id: SkillId): Result<void, KoiError> => {
    const existing = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM skills WHERE skill_id = ?")
      .get(id as string);

    if (existing === null) {
      return { ok: false, error: notFound(id as string, `Skill not found: ${id}`) };
    }

    const result = wrapSqlite(() => {
      db.transaction(() => {
        deleteFts(existing.rowid);
        db.run("DELETE FROM skills WHERE rowid = ?", [existing.rowid]);
      })();
    }, "skill.unpublish");

    if (!result.ok) return result;

    listeners.notify({ kind: "unpublished", skillId: id });
    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // Contract: deprecate
  // -------------------------------------------------------------------------

  const deprecate = (id: SkillId, version: string): Result<void, KoiError> => {
    const skill = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM skills WHERE skill_id = ?")
      .get(id as string);

    if (skill === null) {
      return { ok: false, error: notFound(id as string, `Skill not found: ${id}`) };
    }

    const versionRow = db
      .query<{ rowid: number; deprecated: number }, [number, string]>(
        "SELECT rowid, deprecated FROM skill_versions WHERE skill_rowid = ? AND version = ?",
      )
      .get(skill.rowid, version);

    if (versionRow === null) {
      return { ok: false, error: notFound(id as string, `Version not found: ${version}`) };
    }

    if (versionRow.deprecated === 0) {
      const result = wrapSqlite(() => {
        db.run("UPDATE skill_versions SET deprecated = 1 WHERE rowid = ?", [versionRow.rowid]);
      }, "skill.deprecate");
      if (!result.ok) return result;
    }

    listeners.notify({ kind: "deprecated", skillId: id, version });
    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // Contract: onChange
  // -------------------------------------------------------------------------

  const onChange = (listener: (event: SkillRegistryChangeEvent) => void): (() => void) => {
    return listeners.add(listener);
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const close = (): void => {
    listeners.clear();
    db.run("PRAGMA optimize");
    if (ownsDb) {
      db.close();
    }
  };

  return { publish, search, get, versions, install, unpublish, deprecate, onChange, close };
}
