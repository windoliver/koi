/**
 * @koi/agent-runtime — Agent definition model with built-in and custom agent loading.
 */

// agent definition registry
export type {
  AgentDefinitionRegistry,
  RegistryConflictWarning,
} from "./agent-definition-registry.js";
export { createAgentDefinitionRegistry } from "./agent-definition-registry.js";
// built-in agents
export { BUILT_IN_AGENT_COUNT, getBuiltInAgents } from "./built-in/index.js";
// top-level bootstrap helper
export type { AgentResolverDirs, AgentResolverResult } from "./create-agent-resolver.js";
export { createAgentResolver } from "./create-agent-resolver.js";
// resolver adapter
export { createDefinitionResolver } from "./definition-resolver.js";
// frontmatter parser
export type { FrontmatterResult } from "./frontmatter.js";
export { parseFrontmatter } from "./frontmatter.js";
// custom agent loader
export type {
  AgentLoadWarning,
  FailedAgentType,
  LoadAgentsConfig,
  LoadAgentsResult,
} from "./load-custom-agents.js";
export { loadCustomAgents } from "./load-custom-agents.js";
// agent definition parser
export { parseAgentDefinition } from "./parse-agent-definition.js";
// schema
export type {
  AgentFrontmatter,
  AgentFrontmatterIssue,
  AgentFrontmatterParseResult,
} from "./schema.js";
export { mapFrontmatterToDefinition, validateAgentFrontmatter } from "./schema.js";
// validation
export { validateAgentType } from "./validate-agent-type.js";
