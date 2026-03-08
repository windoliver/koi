/**
 * Types for @koi/nexus-embed — Nexus embed mode lifecycle management.
 */

/** Spawn function type — matches Bun.spawn signature subset. */
export type SpawnFn = (
  cmd: readonly string[],
  options?: {
    readonly cwd?: string | undefined;
    readonly stdio?: readonly string[] | undefined;
    readonly env?: Record<string, string | undefined> | undefined;
  },
) => { readonly pid: number | undefined; readonly unref: () => void };

/** Fetch function type for health checking. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Configuration for ensureNexusRunning(). All fields optional with sane defaults. */
export interface EmbedConfig {
  /** Port for Nexus server. Default: 2026. */
  readonly port?: number | undefined;
  /** Nexus deployment profile. Default: "lite". Override: NEXUS_EMBED_PROFILE env var. */
  readonly profile?: string | undefined;
  /** Data directory for connection state. Default: ~/.koi/nexus/. */
  readonly dataDir?: string | undefined;
  /** Host to bind Nexus to. Default: "127.0.0.1". */
  readonly host?: string | undefined;
  /** Injectable spawn for testing. Default: Bun.spawn. */
  readonly spawn?: SpawnFn | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: FetchFn | undefined;
}

/** Result returned by ensureNexusRunning(). */
export interface EmbedResult {
  /** URL for the running Nexus instance. */
  readonly baseUrl: string;
  /** Whether we spawned a new process (true) or reused existing (false). */
  readonly spawned: boolean;
  /** PID of the Nexus process (if known). */
  readonly pid: number | undefined;
}

/** Persisted connection state stored in embed.json. */
export interface ConnectionState {
  readonly port: number;
  readonly pid: number;
  readonly host: string;
  readonly profile: string;
  readonly startedAt: string;
}
