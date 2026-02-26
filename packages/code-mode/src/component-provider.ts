/**
 * ECS ComponentProvider for code-mode — discovers FILESYSTEM, attaches 3 tools.
 */

import type { Agent, ComponentProvider, FileSystemBackend, Tool, TrustTier } from "@koi/core";
import { FILESYSTEM, toolToken } from "@koi/core";
import { DEFAULT_PREFIX } from "./constants.js";
import { createPlanStore } from "./plan-store.js";
import { createPlanApplyTool } from "./tools/plan-apply.js";
import { createPlanCreateTool } from "./tools/plan-create.js";
import { createPlanStatusTool } from "./tools/plan-status.js";
import type { ValidationConfig } from "./validation.js";
import { DEFAULT_VALIDATION_CONFIG } from "./validation.js";

export interface CodeModeProviderConfig {
  readonly trustTier?: TrustTier;
  readonly prefix?: string;
  readonly validationConfig?: ValidationConfig;
}

/**
 * Create a ComponentProvider that attaches code_plan_create, code_plan_apply,
 * and code_plan_status tools to agents that have a FILESYSTEM component.
 */
export function createCodeModeProvider(config: CodeModeProviderConfig = {}): ComponentProvider {
  const {
    trustTier = "verified",
    prefix = DEFAULT_PREFIX,
    validationConfig = DEFAULT_VALIDATION_CONFIG,
  } = config;

  return {
    name: "code-mode",

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const backend = agent.component<FileSystemBackend>(FILESYSTEM);

      // If no FILESYSTEM component, return empty — tools are unavailable
      if (backend === undefined) {
        return new Map<string, unknown>();
      }

      const store = createPlanStore();

      const tools: readonly Tool[] = [
        createPlanCreateTool(backend, store, prefix, trustTier, validationConfig),
        createPlanApplyTool(backend, store, prefix, trustTier),
        createPlanStatusTool(store, prefix, trustTier),
      ];

      const entries = tools.map(
        (tool) => [toolToken(tool.descriptor.name) as string, tool] as const,
      );

      return new Map<string, unknown>(entries);
    },
  };
}
