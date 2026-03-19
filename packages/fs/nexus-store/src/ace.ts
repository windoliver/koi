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

import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import { validatePathSegment } from "./shared/nexus-helpers.js";

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
// Trajectory types (structurally compatible with @koi/middleware-ace)
// ---------------------------------------------------------------------------

/** Trajectory entry — mirrors @koi/middleware-ace TrajectoryEntry. */
interface TrajectoryEntry {
  readonly turnIndex: number;
  readonly timestamp: number;
  readonly kind: "model_call" | "tool_call";
  readonly identifier: string;
  readonly outcome: "success" | "failure" | "retry";
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly bulletIds?: readonly string[];
}

/** Structurally compatible with @koi/middleware-ace TrajectoryStore. */
export interface NexusTrajectoryStore {
  readonly append: (sessionId: string, entries: readonly TrajectoryEntry[]) => Promise<void>;
  readonly getSession: (sessionId: string) => Promise<readonly TrajectoryEntry[]>;
  readonly listSessions: (options?: {
    readonly limit?: number;
    readonly before?: number;
  }) => Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// Playbook types (structurally compatible with @koi/middleware-ace)
// ---------------------------------------------------------------------------

type PlaybookSource = "curated" | "manual" | "imported";

interface Playbook {
  readonly id: string;
  readonly title: string;
  readonly strategy: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly source: PlaybookSource;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionCount: number;
}

/** Structurally compatible with @koi/middleware-ace PlaybookStore. */
export interface NexusPlaybookStore {
  readonly get: (id: string) => Promise<Playbook | undefined>;
  readonly list: (options?: {
    readonly tags?: readonly string[];
    readonly minConfidence?: number;
  }) => Promise<readonly Playbook[]>;
  readonly save: (playbook: Playbook) => Promise<void>;
  readonly remove: (id: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Structured playbook types (structurally compatible with @koi/middleware-ace)
// ---------------------------------------------------------------------------

interface PlaybookBullet {
  readonly id: string;
  readonly content: string;
  readonly helpful: number;
  readonly harmful: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface PlaybookSection {
  readonly name: string;
  readonly slug: string;
  readonly bullets: readonly PlaybookBullet[];
}

interface StructuredPlaybook {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly PlaybookSection[];
  readonly tags: readonly string[];
  readonly source: PlaybookSource;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionCount: number;
}

/** Structurally compatible with @koi/middleware-ace StructuredPlaybookStore. */
export interface NexusStructuredPlaybookStore {
  readonly get: (id: string) => Promise<StructuredPlaybook | undefined>;
  readonly list: (options?: {
    readonly tags?: readonly string[];
  }) => Promise<readonly StructuredPlaybook[]>;
  readonly save: (playbook: StructuredPlaybook) => Promise<void>;
  readonly remove: (id: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// JSON I/O helpers
// ---------------------------------------------------------------------------

async function readJson<T>(client: NexusClient, path: string): Promise<T | undefined> {
  const r = await client.rpc<string>("read", { path });
  if (!r.ok) {
    if (r.error.code === "EXTERNAL" || r.error.code === "NOT_FOUND") return undefined;
    throw new Error(r.error.message);
  }
  return JSON.parse(r.value) as T;
}

async function writeJson(client: NexusClient, path: string, data: unknown): Promise<void> {
  const r = await client.rpc<null>("write", { path, content: JSON.stringify(data) });
  if (!r.ok) throw new Error(r.error.message);
}

async function deleteJson(client: NexusClient, path: string): Promise<boolean> {
  const exists = await client.rpc<boolean>("exists", { path });
  if (!exists.ok || !exists.value) return false;
  const r = await client.rpc<null>("delete", { path });
  return r.ok;
}

async function globPaths(client: NexusClient, pattern: string): Promise<readonly string[]> {
  const r = await client.rpc<readonly string[]>("glob", { pattern });
  if (!r.ok) return [];
  return r.value;
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
    return `${basePath}/${sessionId}.json`;
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
    return `${basePath}/${id}.json`;
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
    return `${basePath}/${id}.json`;
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
