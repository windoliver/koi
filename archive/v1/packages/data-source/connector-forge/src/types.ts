import type { DataSourceDescriptor } from "@koi/core";
import type { ForgeSkillInput } from "@koi/forge-types";

export interface ConnectorForgeConfig {
  readonly maxSkillBodyTokens?: number;
  readonly includeSchemaProbe?: boolean;
}

export const DEFAULT_CONNECTOR_FORGE_CONFIG: ConnectorForgeConfig = {
  maxSkillBodyTokens: 200,
  includeSchemaProbe: true,
} as const satisfies ConnectorForgeConfig;

/** Strategy to generate a ForgeSkillInput from a data source descriptor. */
export interface SkillStrategy {
  readonly protocol: string;
  readonly generateInput: (descriptor: DataSourceDescriptor) => ForgeSkillInput;
}
