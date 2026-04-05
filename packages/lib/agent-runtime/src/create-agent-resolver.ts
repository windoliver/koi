/**
 * createAgentResolver — top-level bootstrap helper for @koi/agent-runtime.
 *
 * Composes getBuiltInAgents + loadCustomAgents + createAgentDefinitionRegistry
 * + createDefinitionResolver into a single call suitable for runtime bootstrap.
 *
 * @remarks
 * Call once at startup and pass the resulting `resolver` to `createRuntime()`.
 * Do not call per-request — loadCustomAgents performs synchronous filesystem I/O.
 * Missing directories are handled gracefully (empty result, no error).
 */

import type { AgentResolver } from "@koi/core";

import type { RegistryConflictWarning } from "./agent-definition-registry.js";
import { createAgentDefinitionRegistry } from "./agent-definition-registry.js";
import { getBuiltInAgents } from "./built-in/index.js";
import { createDefinitionResolver } from "./definition-resolver.js";
import type { AgentLoadWarning } from "./load-custom-agents.js";
import { loadCustomAgents } from "./load-custom-agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Directory configuration for custom agent discovery. */
export interface AgentResolverDirs {
  /** Project root — scans `<projectDir>/.koi/agents/` for project-level definitions. */
  readonly projectDir?: string | undefined;
  /** User home — scans `<userDir>/.koi/agents/` for user-level definitions. */
  readonly userDir?: string | undefined;
}

/** Result of bootstrapping the agent resolver. */
export interface AgentResolverResult {
  /** Fully initialized resolver — pass to createRuntime() as config.resolver. */
  readonly resolver: AgentResolver;
  /**
   * Warnings from filesystem scanning: unreadable or unparseable .md files.
   * Surface these to the user at startup so they can fix broken agent definitions.
   */
  readonly warnings: readonly AgentLoadWarning[];
  /**
   * Warnings from registry construction: same-tier duplicate agentType definitions.
   * e.g. two project-level .md files with the same `name` frontmatter field.
   */
  readonly conflicts: readonly RegistryConflictWarning[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Bootstrap the agent resolver from built-in and custom agent definitions.
 *
 * Built-ins are always loaded. Custom agents are loaded from:
 * - `dirs.projectDir/.koi/agents/` (project-level, highest priority)
 * - `dirs.userDir/.koi/agents/` (user-level, medium priority)
 *
 * Priority: project > user > built-in. Missing directories are silently skipped.
 * Parse failures produce warnings and prevent silent fallback to lower-priority
 * definitions (fail-closed: a broken project override blocks the built-in).
 */
export function createAgentResolver(dirs?: AgentResolverDirs): AgentResolverResult {
  const builtIn = getBuiltInAgents();

  const loadResult =
    dirs !== undefined
      ? loadCustomAgents({ projectDir: dirs.projectDir, userDir: dirs.userDir })
      : { agents: [], warnings: [], failedTypes: [] };

  const registry = createAgentDefinitionRegistry(
    builtIn,
    loadResult.agents,
    loadResult.failedTypes,
  );

  return {
    resolver: createDefinitionResolver(registry),
    warnings: loadResult.warnings,
    conflicts: registry.warnings,
  };
}
