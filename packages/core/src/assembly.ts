/**
 * Agent manifest and configuration types.
 */

import type { JsonObject } from "./common.js";
import type { DegeneracyConfig } from "./degeneracy.js";
import type { DelegationConfig } from "./delegation.js";
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
}

export interface SkillConfig {
  readonly name: string;
  /** Path to directory containing SKILL.md. Relative to manifest location. */
  readonly path: string;
  readonly options?: JsonObject;
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
  /** Declared task objectives — used by goal drift detection and attention management middleware. */
  readonly objectives?: readonly string[];
  /** Search provider configuration — resolved to a SearchProvider at assembly time. */
  readonly search?: SearchConfig | undefined;
  /**
   * Per-capability degeneracy configuration — maps capability name to config.
   * Capabilities are identified by `capability:<name>` tags on brick artifacts.
   */
  readonly degeneracy?: Readonly<Record<string, DegeneracyConfig>> | undefined;
}
