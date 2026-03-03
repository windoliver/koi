/**
 * ComponentProvider that attaches the exec tool + companion skill to an agent.
 */

import { skillToken } from "@koi/core";
import type { Agent, ComponentProvider } from "@koi/core/ecs";
import { createExecTool } from "./exec-tool.js";
import { EXEC_SKILL, EXEC_SKILL_NAME } from "./skill.js";
import type { ExecToolConfig } from "./types.js";

/**
 * Creates a ComponentProvider that attaches `tool:exec` and `skill:exec-guide`.
 *
 * Both are created once and cached — subsequent attach() calls return
 * the same instances.
 */
export function createExecProvider(config: ExecToolConfig): ComponentProvider {
  // let justified: mutable cache (set once on first attach, reused thereafter)
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name: "tool-exec",

    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (cached !== undefined) return cached;

      const tool = createExecTool(config);
      cached = new Map<string, unknown>([
        ["tool:exec", tool],
        [skillToken(EXEC_SKILL_NAME), EXEC_SKILL],
      ]);
      return cached;
    },
  };
}
