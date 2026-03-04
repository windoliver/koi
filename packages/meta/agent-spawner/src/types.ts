/**
 * Types for the agent-spawner package — config, failure classification, and spawner contract.
 */

import type { ExternalAgentDescriptor, KoiError, Result, SandboxAdapter } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for creating an AgentSpawner. */
export interface AgentSpawnerConfig {
  /** Sandbox adapter used to create isolated containers. */
  readonly adapter: SandboxAdapter;
  /** Working directory inside the sandbox. */
  readonly cwd?: string | undefined;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Maximum concurrent agent delegations. Default: 2. */
  readonly maxConcurrentDelegations?: number | undefined;
  /** Maximum stdout bytes to capture before truncation. Default: 10 MB. */
  readonly maxOutputBytes?: number | undefined;
  /** Sandbox idle TTL in milliseconds before auto-destroy. Default: 60_000. */
  readonly idleTtlMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Discriminated failure kinds for delegation errors. */
export type DelegationFailureKind = "SPAWN_FAILED" | "PARSE_FAILED" | "TIMEOUT";

// ---------------------------------------------------------------------------
// Spawner contract
// ---------------------------------------------------------------------------

/** Spawn options per invocation. */
export interface SpawnOptions {
  /** Override the model used by the coding agent. */
  readonly model?: string | undefined;
  /** Per-invocation timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
}

/** Spawns external coding agents inside sandboxed containers. */
export interface AgentSpawner {
  /** Run an external agent with a prompt and return its text output. */
  readonly spawn: (
    agent: ExternalAgentDescriptor,
    prompt: string,
    options?: SpawnOptions,
  ) => Promise<Result<string, KoiError>>;
  /** Release all sandbox resources. */
  readonly dispose: () => Promise<void>;
}
