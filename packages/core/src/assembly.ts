/**
 * Agent manifest and configuration types.
 */

import type { JsonObject } from "./common.js";
import type { DelegationConfig } from "./delegation.js";

export interface ModelConfig {
  readonly name: string;
  readonly options?: JsonObject;
}

export interface ToolConfig {
  readonly name: string;
  readonly options?: JsonObject;
}

export interface ChannelConfig {
  readonly name: string;
  readonly options?: JsonObject;
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
  readonly metadata?: JsonObject;
}
