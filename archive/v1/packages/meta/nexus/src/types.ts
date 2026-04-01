/**
 * Types for @koi/nexus — L3 composition bundle for Nexus backend wiring.
 */

import type {
  AgentRegistry,
  AuditSink,
  ComponentProvider,
  KoiMiddleware,
  NameServiceBackend,
} from "@koi/core";
import type { PayLedger } from "@koi/core/pay-ledger";
import type { NexusClient } from "@koi/nexus-client";
import type { NexusPermissionBackend } from "@koi/permissions-nexus";
import type { NexusSchedulerBackends } from "@koi/scheduler-nexus";
import type { NexusSearch } from "@koi/search-nexus";

// ---------------------------------------------------------------------------
// Base connection config
// ---------------------------------------------------------------------------

/** Shared connection fields used by all Nexus backends. */
export interface NexusConnectionConfig {
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** Connection config with baseUrl resolved (post-validation / post-embed). */
export interface ResolvedNexusConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Per-backend override configs
// ---------------------------------------------------------------------------

/** Override config for the registry backend. Merged with base connection. */
export interface RegistryOverrides {
  readonly zoneId?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly maxEntries?: number | undefined;
}

/** Override config for the permissions backend. */
export interface PermissionsOverrides {
  readonly timeoutMs?: number | undefined;
}

/** Override config for the audit sink. */
export interface AuditOverrides {
  readonly basePath?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly flushIntervalMs?: number | undefined;
}

/** Override config for the search backend. */
export interface SearchOverrides {
  readonly timeoutMs?: number | undefined;
  readonly maxBatchSize?: number | undefined;
  readonly limit?: number | undefined;
}

/** Override config for the scheduler backends. */
export interface SchedulerOverrides {
  readonly timeoutMs?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
}

/** Override config for the pay ledger. */
export interface PayOverrides {
  readonly timeoutMs?: number | undefined;
}

/** Override config for the name service. */
export interface NameServiceOverrides {
  readonly pollIntervalMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly maxEntries?: number | undefined;
}

/** Override config for gateway (opt-in). */
export interface GatewayOverrides {
  readonly instanceId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Override config for workspace (opt-in). */
export interface WorkspaceOverrides {
  readonly basePath?: string | undefined;
  readonly baseDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Override config for agent-scoped forge store. */
export interface ForgeOverrides {
  readonly concurrency?: number | undefined;
}

/** Override config for agent-scoped event backend. */
export interface EventsOverrides {
  readonly maxEventsPerStream?: number | undefined;
  readonly eventTtlMs?: number | undefined;
}

/** Override config for agent-scoped session store. */
export interface SessionOverrides {
  readonly timeoutMs?: number | undefined;
}

/** Override config for agent-scoped memory backend. */
export interface MemoryOverrides {
  readonly timeoutMs?: number | undefined;
}

/** Override config for agent-scoped snapshot store. */
export interface SnapshotsOverrides {
  readonly timeoutMs?: number | undefined;
}

/** Override config for agent-scoped filesystem backend. */
export interface FilesystemOverrides {
  readonly timeoutMs?: number | undefined;
}

/** Override config for agent-scoped mailbox. */
export interface MailboxOverrides {
  readonly delivery?: "sse" | "polling" | undefined;
  readonly seenCapacity?: number | undefined;
  readonly pollMinMs?: number | undefined;
  readonly pollMaxMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Global backend overrides — set to false to opt-out
// ---------------------------------------------------------------------------

/** Per-backend override map for global backends. Set value to `false` to disable. */
export interface GlobalBackendOverrides {
  readonly registry?: RegistryOverrides | false | undefined;
  readonly permissions?: PermissionsOverrides | false | undefined;
  readonly audit?: AuditOverrides | false | undefined;
  readonly search?: SearchOverrides | false | undefined;
  readonly scheduler?: SchedulerOverrides | false | undefined;
  readonly pay?: PayOverrides | false | undefined;
  readonly nameService?: NameServiceOverrides | false | undefined;
}

/** Per-backend override map for agent-scoped backends. */
export interface AgentBackendOverrides {
  readonly forge?: ForgeOverrides | undefined;
  readonly events?: EventsOverrides | undefined;
  readonly session?: SessionOverrides | undefined;
  readonly memory?: MemoryOverrides | undefined;
  readonly snapshots?: SnapshotsOverrides | undefined;
  readonly filesystem?: FilesystemOverrides | undefined;
  readonly mailbox?: MailboxOverrides | undefined;
}

/** Opt-in backend configs (disabled by default). */
export interface OptInOverrides {
  readonly gateway?: GatewayOverrides | undefined;
  readonly workspace?: WorkspaceOverrides | undefined;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/** User-facing config for createNexusStack(). */
export interface NexusStackConfig extends NexusConnectionConfig {
  /** Per-backend overrides for global (singleton) backends. */
  readonly overrides?: GlobalBackendOverrides | undefined;
  /** Per-backend overrides for agent-scoped backends created in attach(). */
  readonly agentOverrides?: AgentBackendOverrides | undefined;
  /** Opt-in backends (disabled by default). */
  readonly optIn?: OptInOverrides | undefined;
  /** Nexus embed profile (e.g. "lite", "full"). Only used when baseUrl is omitted (embed mode). */
  readonly embedProfile?: string | undefined;
  /** Nexus source directory for `uv run --directory <sourceDir> nexus`. Only used in embed mode. */
  readonly sourceDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Global backends output
// ---------------------------------------------------------------------------

/** The set of eagerly-created global backends. */
export interface NexusGlobalBackends {
  readonly registry: AgentRegistry | undefined;
  readonly permissions: NexusPermissionBackend | undefined;
  readonly audit: AuditSink | undefined;
  readonly search: NexusSearch | undefined;
  readonly scheduler: NexusSchedulerBackends | undefined;
  readonly pay: PayLedger | undefined;
  readonly nameService: NameServiceBackend | undefined;
}

// ---------------------------------------------------------------------------
// Bundle output
// ---------------------------------------------------------------------------

/** Metadata about the resolved Nexus stack composition. */
export interface ResolvedNexusMeta {
  readonly baseUrl: string;
  readonly globalBackendCount: number;
  readonly gatewayEnabled: boolean;
  readonly workspaceEnabled: boolean;
}

/** The composed Nexus stack bundle returned by createNexusStack(). */
export interface NexusBundle {
  readonly backends: NexusGlobalBackends;
  readonly providers: readonly ComponentProvider[];
  readonly middlewares: readonly KoiMiddleware[];
  readonly client: NexusClient;
  readonly config: ResolvedNexusMeta;
  readonly dispose: () => Promise<void>;
}
