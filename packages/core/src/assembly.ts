/**
 * Agent manifest and configuration types.
 */

export interface ModelConfig {
  readonly name: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ToolConfig {
  readonly name: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ChannelConfig {
  readonly name: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface MiddlewareConfig {
  readonly name: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface PermissionConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
}

export interface AgentManifest {
  readonly name: string;
  readonly description?: string;
  readonly model: ModelConfig;
  readonly tools?: readonly ToolConfig[];
  readonly channels?: readonly ChannelConfig[];
  readonly middleware?: readonly MiddlewareConfig[];
  readonly permissions?: PermissionConfig;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
