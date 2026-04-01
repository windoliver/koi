/**
 * Nexus-backed persistence adapters for ACE middleware stores.
 *
 * Stores trajectories, playbooks, and structured playbooks as JSON files
 * on a Nexus server. Provides persistence across restarts for ACE's
 * cross-session self-improvement data.
 *
 * Path conventions:
 *   /ace/trajectories/{sessionId}.json
 *   /ace/playbooks/{id}.json
 *   /ace/structured-playbooks/{id}.json
 *
 * Store interfaces are structurally compatible with the ACE middleware's
 * TrajectoryStore, PlaybookStore, and StructuredPlaybookStore contracts.
 * No cross-L2 import is needed — the CLI (L3) wires them together.
 */

import type {
  Playbook,
  PlaybookStore,
  StructuredPlaybook,
  StructuredPlaybookStore,
  TrajectoryEntry,
  TrajectoryStore,
} from "@koi/ace-types";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import { validatePathSegment } from "./shared/nexus-helpers.js";

/** Sanitize a string for use as a Nexus filename — replace colons with underscores.
 *  Nexus list/glob RPCs don't index files with colons in the name. */
function sanitizeFilename(name: string): string {
  return name.replace(/:/g, "_");
}

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

export interface NexusAceStoreConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly basePath?: string;
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Store type aliases (for backward compatibility with named exports)
// ---------------------------------------------------------------------------

/** Nexus-backed TrajectoryStore — implements @koi/ace-types TrajectoryStore. */
export type NexusTrajectoryStore = TrajectoryStore;

/** Nexus-backed PlaybookStore — implements @koi/ace-types PlaybookStore. */
export type NexusPlaybookStore = PlaybookStore;

/** Nexus-backed StructuredPlaybookStore — implements @koi/ace-types StructuredPlaybookStore. */
export type NexusStructuredPlaybookStore = StructuredPlaybookStore;

// ---------------------------------------------------------------------------
// JSON I/O helpers
// ---------------------------------------------------------------------------

async function readJson<T>(client: NexusClient, path: string): Promise<T | undefined> {
  const r = await client.rpc<unknown>("read", { path });
  if (!r.ok) {
    if (r.error.code === "EXTERNAL" || r.error.code === "NOT_FOUND") return undefined;
    throw new Error(r.error.message);
  }
  // Nexus NFS returns {__type__: "bytes", data: "base64..."} for file reads.
  // Decode the bytes to a UTF-8 string before JSON-parsing.
  const raw = r.value;
  if (typeof raw === "string") return JSON.parse(raw) as T;
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).__type__ === "bytes"
  ) {
    const b64 = (raw as Record<string, unknown>).data;
    if (typeof b64 === "string") {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      return JSON.parse(decoded) as T;
    }
  }
  // Fallback: raw is already a parsed object (unlikely but safe)
  return raw as T;
}

async function writeJson(client: NexusClient, path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data);
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await client.rpc<null>("write", { path, content });
    if (r.ok) return;
    // Retry on rate limit (RATE_LIMIT code or "rate" in message)
    const isRateLimit =
      r.error.code === "RATE_LIMIT" || r.error.message.toLowerCase().includes("rate");
    if (attempt < maxRetries && isRateLimit) {
      // Exponential backoff: 2s, 4s, 8s, 16s
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(r.error.message);
  }
}

async function deleteJson(client: NexusClient, path: string): Promise<boolean> {
  const exists = await client.rpc<boolean>("exists", { path });
  if (!exists.ok || !exists.value) return false;
  const r = await client.rpc<null>("delete", { path });
  return r.ok;
}

async function globPaths(client: NexusClient, pattern: string): Promise<readonly string[]> {
  const r = await client.rpc<unknown>("glob", { pattern });
  if (!r.ok) return [];
  const v = r.value;
  // Nexus glob returns { matches: string[] } — unwrap if needed
  if (Array.isArray(v)) return v as readonly string[];
  if (
    v !== null &&
    typeof v === "object" &&
    "matches" in v &&
    Array.isArray((v as { matches: unknown }).matches)
  ) {
    return (v as { matches: readonly string[] }).matches;
  }
  return [];
}

// ---------------------------------------------------------------------------
// TrajectoryStore factory
// ---------------------------------------------------------------------------

const DEFAULT_TRAJECTORY_PATH = "ace/trajectories";

/** Create a Nexus-backed TrajectoryStore for ACE middleware. */
export function createNexusTrajectoryStore(config: NexusAceStoreConfig): NexusTrajectoryStore {
  const basePath = config.basePath ?? DEFAULT_TRAJECTORY_PATH;
  const client = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  function sessionPath(sessionId: string): string {
    return `${basePath}/${sanitizeFilename(sessionId)}.json`;
  }

  const append = async (sessionId: string, entries: readonly TrajectoryEntry[]): Promise<void> => {
    const segCheck = validatePathSegment(sessionId, "Session ID");
    if (!segCheck.ok) throw new Error(segCheck.error.message);

    const existing = await readJson<readonly TrajectoryEntry[]>(client, sessionPath(sessionId));
    const merged = [...(existing ?? []), ...entries];
    await writeJson(client, sessionPath(sessionId), merged);
  };

  const getSession = async (sessionId: string): Promise<readonly TrajectoryEntry[]> => {
    const segCheck = validatePathSegment(sessionId, "Session ID");
    if (!segCheck.ok) return [];
    return (await readJson<readonly TrajectoryEntry[]>(client, sessionPath(sessionId))) ?? [];
  };

  const listSessions = async (options?: {
    readonly limit?: number;
    readonly before?: number;
  }): Promise<readonly string[]> => {
    const paths = await globPaths(client, `${basePath}/*.json`);
    const ids = paths.map((p) => {
      const fileName = p.split("/").pop() ?? "";
      return fileName.replace(".json", "");
    });
    const limit = options?.limit ?? ids.length;
    return ids.slice(0, limit);
  };

  return { append, getSession, listSessions };
}

// ---------------------------------------------------------------------------
// PlaybookStore factory
// ---------------------------------------------------------------------------

const DEFAULT_PLAYBOOK_PATH = "ace/playbooks";

/** Create a Nexus-backed PlaybookStore for ACE middleware. */
export function createNexusPlaybookStore(config: NexusAceStoreConfig): NexusPlaybookStore {
  const basePath = config.basePath ?? DEFAULT_PLAYBOOK_PATH;
  const client = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  function playbookPath(id: string): string {
    return `${basePath}/${sanitizeFilename(id)}.json`;
  }

  const get = async (id: string): Promise<Playbook | undefined> => {
    const segCheck = validatePathSegment(id, "Playbook ID");
    if (!segCheck.ok) return undefined;
    return readJson<Playbook>(client, playbookPath(id));
  };

  const list = async (options?: {
    readonly tags?: readonly string[];
    readonly minConfidence?: number;
  }): Promise<readonly Playbook[]> => {
    const paths = await globPaths(client, `${basePath}/*.json`);
    const results: Playbook[] = [];

    for (const p of paths) {
      const pb = await readJson<Playbook>(client, p);
      if (pb === undefined) continue;

      if (options?.minConfidence !== undefined && pb.confidence < options.minConfidence) continue;
      if (options?.tags !== undefined && options.tags.length > 0) {
        if (!options.tags.some((tag) => pb.tags.includes(tag))) continue;
      }
      results.push(pb);
    }
    return results;
  };

  const save = async (playbook: Playbook): Promise<void> => {
    const segCheck = validatePathSegment(playbook.id, "Playbook ID");
    if (!segCheck.ok) throw new Error(segCheck.error.message);
    await writeJson(client, playbookPath(playbook.id), playbook);
  };

  const remove = async (id: string): Promise<boolean> => {
    const segCheck = validatePathSegment(id, "Playbook ID");
    if (!segCheck.ok) return false;
    return deleteJson(client, playbookPath(id));
  };

  return { get, list, save, remove };
}

// ---------------------------------------------------------------------------
// StructuredPlaybookStore factory
// ---------------------------------------------------------------------------

const DEFAULT_STRUCTURED_PLAYBOOK_PATH = "ace/structured-playbooks";

/** Create a Nexus-backed StructuredPlaybookStore for ACE middleware. */
export function createNexusStructuredPlaybookStore(
  config: NexusAceStoreConfig,
): NexusStructuredPlaybookStore {
  const basePath = config.basePath ?? DEFAULT_STRUCTURED_PLAYBOOK_PATH;
  const client = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  function playbookPath(id: string): string {
    return `${basePath}/${sanitizeFilename(id)}.json`;
  }

  const get = async (id: string): Promise<StructuredPlaybook | undefined> => {
    const segCheck = validatePathSegment(id, "Structured playbook ID");
    if (!segCheck.ok) return undefined;
    return readJson<StructuredPlaybook>(client, playbookPath(id));
  };

  const list = async (options?: {
    readonly tags?: readonly string[];
  }): Promise<readonly StructuredPlaybook[]> => {
    const paths = await globPaths(client, `${basePath}/*.json`);
    const results: StructuredPlaybook[] = [];

    for (const p of paths) {
      const pb = await readJson<StructuredPlaybook>(client, p);
      if (pb === undefined) continue;

      if (options?.tags !== undefined && options.tags.length > 0) {
        if (!options.tags.some((tag) => pb.tags.includes(tag))) continue;
      }
      results.push(pb);
    }
    return results;
  };

  const save = async (playbook: StructuredPlaybook): Promise<void> => {
    const segCheck = validatePathSegment(playbook.id, "Structured playbook ID");
    if (!segCheck.ok) throw new Error(segCheck.error.message);
    await writeJson(client, playbookPath(playbook.id), playbook);
  };

  const remove = async (id: string): Promise<boolean> => {
    const segCheck = validatePathSegment(id, "Structured playbook ID");
    if (!segCheck.ok) return false;
    return deleteJson(client, playbookPath(id));
  };

  return { get, list, save, remove };
}

// ---------------------------------------------------------------------------
// NexusAtifDocumentDelegate — generic JSON document persistence for ATIF
// ---------------------------------------------------------------------------

const DEFAULT_ATIF_PATH = "ace/atif-documents";

/**
 * Generic JSON document delegate backed by Nexus NFS.
 *
 * Structurally compatible with @koi/middleware-ace AtifDocumentDelegate.
 * Stores each document as a JSON file at `{basePath}/{docId}.json`.
 */
export interface NexusJsonDocumentDelegate {
  readonly read: (docId: string) => Promise<unknown | undefined>;
  readonly write: (docId: string, doc: unknown) => Promise<void>;
  readonly list: () => Promise<readonly string[]>;
  readonly delete: (docId: string) => Promise<boolean>;
}

/** Create a Nexus-backed JSON document delegate for ATIF document storage. */
export function createNexusAtifDelegate(config: NexusAceStoreConfig): NexusJsonDocumentDelegate {
  const basePath = config.basePath ?? DEFAULT_ATIF_PATH;
  const client = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  function docPath(docId: string): string {
    return `${basePath}/${sanitizeFilename(docId)}.json`;
  }

  return {
    async read(docId: string): Promise<unknown | undefined> {
      const segCheck = validatePathSegment(docId, "ATIF document ID");
      if (!segCheck.ok) return undefined;
      return readJson<unknown>(client, docPath(docId));
    },

    async write(docId: string, doc: unknown): Promise<void> {
      const segCheck = validatePathSegment(docId, "ATIF document ID");
      if (!segCheck.ok) throw new Error(segCheck.error.message);
      await writeJson(client, docPath(docId), doc);
    },

    async list(): Promise<readonly string[]> {
      const paths = await globPaths(client, `${basePath}/*.json`);
      return paths.map((p) => {
        const fileName = p.split("/").pop() ?? "";
        return fileName.replace(".json", "");
      });
    },

    async delete(docId: string): Promise<boolean> {
      const segCheck = validatePathSegment(docId, "ATIF document ID");
      if (!segCheck.ok) return false;
      return deleteJson(client, docPath(docId));
    },
  };
}
