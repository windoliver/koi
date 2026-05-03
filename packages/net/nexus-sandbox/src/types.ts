/**
 * Types for @koi/nexus-sandbox — local nexus-ai-fs[sandbox] subprocess.
 *
 * SpawnFn / FetchFn / SpawnedProcess match a Bun.spawn-compatible subset
 * so callers can inject mocks in unit tests.
 */

export interface SpawnedProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly kill: (signal?: string | number) => void;
  readonly unref: () => void;
}

export interface SpawnOptions {
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly stdio?: readonly string[] | undefined;
}

export type SpawnFn = (cmd: readonly string[], opts?: SpawnOptions) => SpawnedProcess;

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResolveCommandOptions {
  /** Explicit argv override; beats env and sourceDir. */
  readonly command?: readonly string[] | undefined;
  /** Local nexus repo for contributor mode (`uv run --directory <sourceDir> nexus`). */
  readonly sourceDir?: string | undefined;
}

export interface SandboxConfig {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly enableVectorSearch?: boolean | undefined;
  readonly embeddingModel?: string | undefined;
  readonly healthTimeoutMs?: number | undefined;
  readonly command?: readonly string[] | undefined;
  readonly sourceDir?: string | undefined;
  readonly spawn?: SpawnFn | undefined;
  readonly fetch?: FetchFn | undefined;
}

export interface SandboxHandle {
  readonly baseUrl: string;
  readonly pid: number | undefined;
  readonly dataDir: string;
  /** Internal: subprocess handle for stopSandbox. Not part of the stable API. */
  readonly _process: SpawnedProcess;
}

export interface StopOptions {
  /** Graceful drain window before SIGKILL. Default: 5000 ms. */
  readonly drainMs?: number | undefined;
}
