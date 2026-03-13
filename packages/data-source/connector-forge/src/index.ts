/**
 * @koi/connector-forge — Generate data access skills from discovered data sources.
 *
 * L2 package. Depends on @koi/core (L0) and L0u utilities only.
 */

// forge-skills — main entry point
export type { ForgeDataSourceSkillsResult } from "./forge-skills.js";
export { forgeDataSourceSkills } from "./forge-skills.js";
export { createGraphqlStrategy, createHttpStrategy } from "./strategies/http.js";
export { createMcpStrategy } from "./strategies/mcp.js";

// strategies
export { createPostgresStrategy } from "./strategies/postgres.js";
// tools — probe-schema
export type {
  SchemaColumn,
  SchemaProbeResult,
  SchemaTable,
} from "./tools/probe-schema.js";
export { getSchemaProbeQuery } from "./tools/probe-schema.js";

// tools — query-datasource
export type {
  DataSourceQuery,
  QueryDataSourceInput,
  QueryDataSourceResult,
} from "./tools/query-datasource.js";
export { validateQueryInput } from "./tools/query-datasource.js";
// tools — runtime tool factories
export type {
  ProbeSchemaToolConfig,
  QueryDataSourceToolConfig,
} from "./tools/tool-factories.js";
export {
  createProbeSchemaToolTool,
  createQueryDataSourceTool,
} from "./tools/tool-factories.js";
// types
export type { ConnectorForgeConfig, SkillStrategy } from "./types.js";
export { DEFAULT_CONNECTOR_FORGE_CONFIG } from "./types.js";
