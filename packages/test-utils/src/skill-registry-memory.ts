/**
 * In-memory reference implementation of SkillRegistryBackend.
 *
 * Suitable for testing and as a reference for L2 implementations.
 * Uses a Map<SkillId, SkillRecord> for storage.
 */

import type {
  KoiError,
  Result,
  SkillId,
  SkillPage,
  SkillPublishRequest,
  SkillRegistryBackend,
  SkillRegistryChangeEvent,
  SkillRegistryEntry,
  SkillSearchQuery,
  SkillVersion,
} from "@koi/core";
import { conflict, DEFAULT_SKILL_SEARCH_LIMIT, notFound, validation } from "@koi/core";
import type { BrickRequires, SkillArtifact } from "@koi/core/brick-store";
import { DEFAULT_PROVENANCE } from "./brick-artifacts.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface VersionRecord {
  readonly version: string;
  readonly content: string;
  readonly integrity?: string;
  readonly publishedAt: number;
  readonly deprecated: boolean;
}

interface SkillRecord {
  readonly id: SkillId;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly author?: string;
  readonly requires?: BrickRequires;
  readonly versions: readonly VersionRecord[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an in-memory SkillRegistryBackend for testing. */
export function createInMemorySkillRegistry(): SkillRegistryBackend {
  // Mutable internal state — exposed only through immutable return values
  const store = new Map<SkillId, SkillRecord>();
  const downloads = new Map<SkillId, number>();
  const listeners = new Set<(event: SkillRegistryChangeEvent) => void>();

  function notifyListeners(event: SkillRegistryChangeEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function latestVersion(record: SkillRecord): VersionRecord {
    // versions array is always non-empty after publish
    const last = record.versions[record.versions.length - 1];
    if (last === undefined) throw new Error("invariant: versions array is empty");
    return last;
  }

  function toEntry(record: SkillRecord): SkillRegistryEntry {
    const latest = latestVersion(record);
    const base = {
      id: record.id,
      name: record.name,
      description: record.description,
      tags: record.tags,
      version: latest.version,
      publishedAt: latest.publishedAt,
    };
    const downloadCount = downloads.get(record.id);
    return {
      ...base,
      ...(record.author !== undefined ? { author: record.author } : {}),
      ...(record.requires !== undefined ? { requires: record.requires } : {}),
      ...(downloadCount !== undefined ? { downloads: downloadCount } : {}),
    };
  }

  function toSkillVersions(record: SkillRecord): readonly SkillVersion[] {
    // Return newest first
    return [...record.versions].reverse().map((v) => {
      const base: SkillVersion = { version: v.version, publishedAt: v.publishedAt };
      const withIntegrity = v.integrity !== undefined ? { ...base, integrity: v.integrity } : base;
      return v.deprecated ? { ...withIntegrity, deprecated: true } : withIntegrity;
    });
  }

  function makeVersionRecord(request: SkillPublishRequest): VersionRecord {
    const base: VersionRecord = {
      version: request.version,
      content: request.content,
      publishedAt: Date.now(),
      deprecated: false,
    };
    return request.integrity !== undefined ? { ...base, integrity: request.integrity } : base;
  }

  function matchesText(record: SkillRecord, text: string): boolean {
    const lower = text.toLowerCase();
    return (
      record.name.toLowerCase().includes(lower) || record.description.toLowerCase().includes(lower)
    );
  }

  function matchesTags(record: SkillRecord, tags: readonly string[]): boolean {
    return tags.every((tag) => record.tags.includes(tag));
  }

  function matchesAuthor(record: SkillRecord, author: string): boolean {
    return record.author === author;
  }

  // -------------------------------------------------------------------------
  // Reader
  // -------------------------------------------------------------------------

  const search = (query: SkillSearchQuery): SkillPage => {
    const limit = query.limit ?? DEFAULT_SKILL_SEARCH_LIMIT;
    const rawOffset = query.cursor !== undefined ? Number.parseInt(query.cursor, 10) : 0;
    const offset = Number.isNaN(rawOffset) ? 0 : rawOffset;

    const all = [...store.values()];
    const filtered = all.filter((record) => {
      if (query.text !== undefined && !matchesText(record, query.text)) return false;
      if (query.tags !== undefined && query.tags.length > 0 && !matchesTags(record, query.tags))
        return false;
      if (query.author !== undefined && !matchesAuthor(record, query.author)) return false;
      return true;
    });

    const page = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < filtered.length;

    const base = { items: page.map(toEntry), total: filtered.length };
    return hasMore ? { ...base, cursor: String(offset + limit) } : base;
  };

  const get = (id: SkillId): Result<SkillRegistryEntry, KoiError> => {
    const record = store.get(id);
    if (record === undefined) {
      return { ok: false, error: notFound(id, `Skill not found: ${id}`) };
    }
    return { ok: true, value: toEntry(record) };
  };

  const versions = (id: SkillId): Result<readonly SkillVersion[], KoiError> => {
    const record = store.get(id);
    if (record === undefined) {
      return { ok: false, error: notFound(id, `Skill not found: ${id}`) };
    }
    return { ok: true, value: toSkillVersions(record) };
  };

  const install = async (
    id: SkillId,
    version?: string,
  ): Promise<Result<SkillArtifact, KoiError>> => {
    const record = store.get(id);
    if (record === undefined) {
      return { ok: false, error: notFound(id, `Skill not found: ${id}`) };
    }

    const versionRecord =
      version !== undefined
        ? record.versions.find((v) => v.version === version)
        : record.versions[record.versions.length - 1];

    if (versionRecord === undefined) {
      return {
        ok: false,
        error: notFound(id, `Version not found: ${version ?? "latest"}`),
      };
    }

    // Increment download count
    downloads.set(id, (downloads.get(id) ?? 0) + 1);

    const artifact: SkillArtifact = {
      id,
      kind: "skill",
      name: record.name,
      description: record.description,
      scope: "global",
      trustTier: "sandbox",
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: versionRecord.version,
      tags: [...record.tags],
      usageCount: 0,
      contentHash: "", // not computed in in-memory registry; L2 implementations should hash content
      content: versionRecord.content,
    };

    return { ok: true, value: artifact };
  };

  const onChange = (listener: (event: SkillRegistryChangeEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // -------------------------------------------------------------------------
  // Writer
  // -------------------------------------------------------------------------

  const publish = (request: SkillPublishRequest): Result<SkillRegistryEntry, KoiError> => {
    if (request.name.trim() === "") {
      return { ok: false, error: validation("Skill name must not be empty") };
    }
    if (request.version.trim() === "") {
      return { ok: false, error: validation("Skill version must not be empty") };
    }

    const existing = store.get(request.id);
    if (existing !== undefined) {
      const dup = existing.versions.find((v) => v.version === request.version);
      if (dup !== undefined) {
        return {
          ok: false,
          error: conflict(
            request.id,
            `Version ${request.version} already exists for skill ${request.id}`,
          ),
        };
      }

      const newVersion = makeVersionRecord(request);

      const updated: SkillRecord = {
        ...existing,
        name: request.name,
        description: request.description,
        tags: request.tags,
        versions: [...existing.versions, newVersion],
        ...(request.author !== undefined ? { author: request.author } : {}),
        ...(request.requires !== undefined ? { requires: request.requires } : {}),
      };

      store.set(request.id, updated);
      notifyListeners({ kind: "published", skillId: request.id, version: request.version });
      return { ok: true, value: toEntry(updated) };
    }

    const newVersion = makeVersionRecord(request);

    const record: SkillRecord = {
      id: request.id,
      name: request.name,
      description: request.description,
      tags: request.tags,
      versions: [newVersion],
      ...(request.author !== undefined ? { author: request.author } : {}),
      ...(request.requires !== undefined ? { requires: request.requires } : {}),
    };

    store.set(request.id, record);
    notifyListeners({ kind: "published", skillId: request.id, version: request.version });
    return { ok: true, value: toEntry(record) };
  };

  const unpublish = (id: SkillId): Result<void, KoiError> => {
    if (!store.has(id)) {
      return { ok: false, error: notFound(id, `Skill not found: ${id}`) };
    }
    store.delete(id);
    notifyListeners({ kind: "unpublished", skillId: id });
    return { ok: true, value: undefined };
  };

  const deprecate = (id: SkillId, version: string): Result<void, KoiError> => {
    const record = store.get(id);
    if (record === undefined) {
      return { ok: false, error: notFound(id, `Skill not found: ${id}`) };
    }

    const versionIndex = record.versions.findIndex((v) => v.version === version);
    if (versionIndex === -1) {
      return {
        ok: false,
        error: notFound(id, `Version not found: ${version}`),
      };
    }

    const updatedVersions = record.versions.map((v, i) =>
      i === versionIndex ? { ...v, deprecated: true } : v,
    );

    store.set(id, { ...record, versions: updatedVersions });
    notifyListeners({ kind: "deprecated", skillId: id, version });
    return { ok: true, value: undefined };
  };

  return {
    search,
    get,
    versions,
    install,
    onChange,
    publish,
    unpublish,
    deprecate,
  };
}
