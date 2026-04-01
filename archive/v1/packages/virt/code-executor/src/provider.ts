/**
 * ComponentProvider for Code Mode.
 *
 * Attaches the `execute_script` tool to an agent, allowing the LLM to write
 * scripts that call multiple tools in a single turn.
 *
 * **Important:** This provider should be registered AFTER other tool providers
 * so that `agent.query("tool:")` sees all existing tools when building the
 * tool map for the script sandbox.
 */

import type { Agent, ComponentProvider, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, toolToken } from "@koi/core";
import { createExecuteScriptTool } from "./execute-script-tool.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createCodeExecutorProvider(): ComponentProvider {
  return {
    name: "code-executor",
    // Run after bundled providers so we see all existing tools.
    priority: COMPONENT_PRIORITY.BUNDLED + 10,

    async attach(agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      // Query all existing tools on the agent.
      const existingTools = agent.query<Tool>("tool:");

      // Build name → Tool map, excluding execute_script itself to avoid recursion.
      const toolMap = new Map<string, Tool>();
      for (const [_token, tool] of existingTools) {
        if (tool.descriptor.name !== "execute_script") {
          toolMap.set(tool.descriptor.name, tool);
        }
      }

      const executeScript = createExecuteScriptTool(toolMap);

      return new Map<string, unknown>([[toolToken("execute_script") as string, executeScript]]);
    },
  };
}
