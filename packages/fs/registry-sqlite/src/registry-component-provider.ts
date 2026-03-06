/**
 * Registry ComponentProvider — attaches registry Tool components to an agent.
 *
 * Uses createServiceProvider to wire BrickRegistryReader, SkillRegistryReader,
 * and VersionIndexReader into 4 agent-facing tools:
 *   - registry_search   (verified) — FTS5 search across bricks
 *   - registry_get       (verified) — get brick details
 *   - registry_list_versions (verified) — list version history
 *   - registry_install   (promoted) — install a brick (via customTools hook)
 *
 * Plus a skill component (registry-guide) for agent guidance.
 */

import type {
  Agent,
  BrickRegistryReader,
  ComponentProvider,
  RegistryComponent,
  SkillRegistryReader,
  Tool,
  ToolPolicy,
  VersionIndexReader,
} from "@koi/core";
import {
  createServiceProvider,
  DEFAULT_UNSANDBOXED_POLICY,
  REGISTRY,
  skillToken,
  toolToken,
} from "@koi/core";
import { createRegistrySkillComponent } from "./registry-skill.js";
import { createRegistryGetTool } from "./tools/registry-get.js";
import type { OnInstallCallback } from "./tools/registry-install.js";
import { createRegistryInstallTool } from "./tools/registry-install.js";
import { createRegistryListVersionsTool } from "./tools/registry-list-versions.js";
import { createRegistrySearchTool } from "./tools/registry-search.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RegistryProviderConfig {
  readonly bricks: BrickRegistryReader;
  readonly skills: SkillRegistryReader;
  readonly versions: VersionIndexReader;
  /** Trust tier for read tools. Default: "verified". */
  readonly policy?: ToolPolicy;
  /** Tool name prefix. Default: "registry". */
  readonly prefix?: string;
  /** Assembly priority. */
  readonly priority?: number;
  /** Callback invoked on registry_install. Omit for download-only mode. */
  readonly onInstall?: OnInstallCallback;
}

// ---------------------------------------------------------------------------
// Standard operations (read-only, "verified" tier)
// ---------------------------------------------------------------------------

const OPERATIONS = ["search", "get", "list_versions"] as const;

type RegistryOperation = (typeof OPERATIONS)[number];

const TOOL_FACTORIES: Readonly<
  Record<
    RegistryOperation,
    (backend: RegistryComponent, prefix: string, policy: ToolPolicy) => Tool
  >
> = {
  search: (b, p, t) => createRegistrySearchTool(b, p, t),
  get: (b, p, t) => createRegistryGetTool(b, p, t),
  list_versions: (b, p, t) => createRegistryListVersionsTool(b, p, t),
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistryProvider(config: RegistryProviderConfig): ComponentProvider {
  const {
    bricks,
    skills,
    versions,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "registry",
    priority,
    onInstall,
  } = config;

  const backend: RegistryComponent = { bricks, skills, versions };

  return createServiceProvider<RegistryComponent, RegistryOperation>({
    name: "registry-sqlite",
    singletonToken: REGISTRY,
    backend,
    operations: OPERATIONS,
    factories: TOOL_FACTORIES,
    policy,
    prefix,
    priority,
    cache: true,
    customTools: (be: RegistryComponent, _agent: Agent) => {
      const installTool = createRegistryInstallTool(
        be,
        prefix,
        DEFAULT_UNSANDBOXED_POLICY,
        onInstall,
      );
      const skill = createRegistrySkillComponent();

      return [
        [toolToken(installTool.descriptor.name) as string, installTool],
        [skillToken("registry-guide") as string, skill],
      ];
    },
  });
}
