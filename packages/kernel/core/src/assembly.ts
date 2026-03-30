/**
 * Agent manifest and configuration types.
 */

import type { BrickId } from "./brick-snapshot.js";
import type { JsonObject } from "./common.js";
import type { DegeneracyConfig } from "./degeneracy.js";
import type { DelegationConfig } from "./delegation.js";
import type { DeliveryPolicy } from "./delivery.js";
import type { FilesystemPolicy, NetworkPolicy, ResourceLimits } from "./sandbox-profile.js";
import type { SupervisionConfig } from "./supervision.js";
import type { OutboundWebhookConfig } from "./webhook.js";

export interface ModelConfig {
  readonly name: string;
  readonly options?: JsonObject;
  /** Fallback model names for routing. Tried in order on primary failure. */
  readonly fallbacks?: readonly string[];
}

export interface ToolConfig {
  readonly name: string;
  readonly options?: JsonObject;
  readonly version?: string;
  readonly publisher?: string;
  /**
   * Package name that exports a `ToolRegistration` for auto-resolution.
   * When present, the engine imports this package at assembly time and
   * auto-wires its ComponentProvider. When absent, the tool must be
   * provided via an explicit ComponentProvider in CreateKoiOptions.providers.
   */
  readonly package?: string | undefined;
}

/** Filesystem skill — loaded from SKILL.md on disk. */
export interface FilesystemSkillSource {
  readonly kind: "filesystem";
  /** Path to directory containing SKILL.md. Relative to manifest location. */
  readonly path: string;
}

/** Forged skill — loaded from ForgeStore by content-addressed BrickId. */
export interface ForgedSkillSource {
  readonly kind: "forged";
  readonly brickId: BrickId;
}

/** Discriminated source for skill loading. */
export type SkillSource = FilesystemSkillSource | ForgedSkillSource;

export interface SkillConfig {
  readonly name: string;
  readonly source: SkillSource;
  readonly options?: JsonObject;
}

/** Creates a filesystem skill config. */
export function fsSkill(name: string, path: string, options?: JsonObject): SkillConfig {
  return {
    name,
    source: { kind: "filesystem", path },
    ...(options !== undefined ? { options } : {}),
  };
}

/** Creates a forged skill config. */
export function forgedSkill(name: string, brickId: BrickId, options?: JsonObject): SkillConfig {
  return {
    name,
    source: { kind: "forged", brickId },
    ...(options !== undefined ? { options } : {}),
  };
}

export interface ChannelIdentity {
  /** Display name for this channel persona — injected as "You are <name>." in the system prompt. */
  readonly name?: string;
  /** Avatar URL or path — display metadata for the channel UI layer, not injected into the LLM prompt. */
  readonly avatar?: string;
  /** Behavioral instructions — injected verbatim into the system prompt. */
  readonly instructions?: string;
}

export interface ChannelConfig {
  readonly name: string;
  readonly options?: JsonObject;
  readonly identity?: ChannelIdentity;
  readonly version?: string;
  readonly publisher?: string;
}

export interface MiddlewareConfig {
  readonly name: string;
  readonly options?: JsonObject;
  readonly version?: string;
  readonly publisher?: string;
  /** When false, resolution failure produces a warning instead of aborting. Defaults to true. */
  readonly required?: boolean | undefined;
}

export interface SearchConfig {
  readonly name: string;
  readonly options?: JsonObject | undefined;
}

export interface PermissionConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
}

/**
 * Configuration for the capability token subsystem, embedded in AgentManifest.
 *
 * Controls whether an agent participates in the capability system, how deep
 * delegation chains are permitted, and the default token TTL.
 *
 * `requiresPoP` is reserved for v2 Proof-of-Possession enforcement.
 * When set to true in the manifest, the engine will eventually enforce PoP
 * challenges before granting capability-protected resources. Not enforced in v1.
 */
export interface CapabilityConfig {
  readonly enabled: boolean;
  /** Maximum delegation chain depth. Root token = depth 0. */
  readonly maxChainDepth: number;
  /** Default token TTL in milliseconds. */
  readonly defaultTtlMs: number;
  /** Reserved for v2 PoP enforcement. Not enforced in v1. */
  readonly requiresPoP?: boolean;
}

/** Cross-session sandbox persistence configuration. */
export interface ManifestSandboxPersistence {
  /**
   * Scope key for sandbox reuse.
   *
   * Sandboxes with the same scope are reattached across sessions instead of
   * being destroyed. The bridge calls `adapter.findOrCreate(scope, profile)`
   * and `instance.detach()` instead of `destroy()` on dispose.
   */
  readonly scope: string;
  /** Human-readable label for the persistent sandbox (e.g., "my-dev-sandbox"). */
  readonly label?: string | undefined;
  /** Auto-destroy after this many ms of idle time. Overrides stack-level idleTtlMs. */
  readonly idleTtlMs?: number | undefined;
  /** Hard upper bound on sandbox lifetime in ms. Sandbox is destroyed after this regardless of activity. */
  readonly maxLifetimeMs?: number | undefined;
}

/**
 * Declarative sandbox configuration for agent manifests.
 *
 * When present on a manifest, the agent should be spawned inside an isolated
 * sandbox (E2B, Daytona, OS-level, etc.) rather than in-process. The runtime
 * resolves this config into a full SandboxProfile for the chosen adapter.
 */
export interface ManifestSandboxConfig {
  /** Sandbox adapter name (e.g., "e2b", "daytona", "os"). Undefined = use default. */
  readonly adapter?: string | undefined;
  /** Filesystem policy overrides for the sandbox. */
  readonly filesystem?: FilesystemPolicy | undefined;
  /** Network policy — defaults to deny for forged agents. */
  readonly network?: NetworkPolicy | undefined;
  /** Resource limit overrides. */
  readonly resources?: ResourceLimits | undefined;
  /** Cross-session persistence. When set, sandbox is detached instead of destroyed. */
  readonly persistence?: ManifestSandboxPersistence | undefined;
}

export interface AgentManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly model: ModelConfig;
  readonly tools?: readonly ToolConfig[];
  readonly channels?: readonly ChannelConfig[];
  readonly middleware?: readonly MiddlewareConfig[];
  readonly permissions?: PermissionConfig;
  readonly delegation?: DelegationConfig;
  readonly capability?: CapabilityConfig;
  readonly supervision?: SupervisionConfig;
  readonly skills?: readonly SkillConfig[];
  readonly outboundWebhooks?: readonly OutboundWebhookConfig[] | undefined;
  /**
   * Lifecycle behavior declaration — "copilot" survives parent death,
   * "worker" is cascade-terminated with parent.
   * When undefined, inferred at runtime: worker if spawned, copilot if top-level.
   */
  readonly lifecycle?: "copilot" | "worker" | undefined;
  readonly metadata?: JsonObject;
  /**
   * Sandbox configuration — when present, the agent should be spawned
   * inside an isolated sandbox environment. When absent, the agent runs
   * in-process (default for lightweight workers).
   */
  readonly sandbox?: ManifestSandboxConfig | undefined;
  /** Declared agent capabilities for discovery and handoff routing. */
  readonly capabilities?: readonly string[] | undefined;
  /** Declared task objectives — used by goal drift detection and attention management middleware. */
  readonly objectives?: readonly string[];
  /** Project conventions preserved through compaction — surfaced via middleware capabilities. */
  readonly conventions?: readonly string[] | undefined;
  /** Search provider configuration — resolved to a SearchProvider at assembly time. */
  readonly search?: SearchConfig | undefined;
  /**
   * Per-capability degeneracy configuration — maps capability name to config.
   * Capabilities are identified by `capability:<name>` tags on brick artifacts.
   */
  readonly degeneracy?: Readonly<Record<string, DegeneracyConfig>> | undefined;
  /**
   * When true, the agent transitions to "idle" after task completion instead
   * of terminating, enabling reuse via the agent pool. Scheduler-triggered
   * tasks always pool regardless of this flag.
   */
  readonly reuse?: boolean | undefined;
  /**
   * Default delivery policy for this agent when spawned as a child.
   * Controls how the child's results flow back to the parent.
   * Can be overridden per-spawn via SpawnRequest.delivery.
   */
  readonly delivery?: DeliveryPolicy | undefined;
}
