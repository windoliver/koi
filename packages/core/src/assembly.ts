/**
 * Agent manifest and configuration types.
 */

import type { JsonObject } from "./common.js";
import type { DelegationConfig } from "./delegation.js";
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
}

export interface MiddlewareConfig {
  readonly name: string;
  readonly options?: JsonObject;
}

export interface PermissionConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
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
  readonly outboundWebhooks?: readonly OutboundWebhookConfig[] | undefined;
  readonly metadata?: JsonObject;
}
