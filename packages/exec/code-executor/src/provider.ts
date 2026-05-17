import type { Agent, ComponentProvider, SandboxExecutor } from "@koi/core";
import { COMPONENT_PRIORITY, toolToken } from "@koi/core";
import { createExecuteScriptTool } from "./execute-script-tool.js";

export interface CodeExecutorProviderConfig {
  readonly executor: SandboxExecutor;
  readonly workspacePath?: string | undefined;
  readonly workspaceWrite?: boolean | undefined;
  readonly priority?: number;
}

export function createCodeExecutorProvider(config: CodeExecutorProviderConfig): ComponentProvider {
  const tool = createExecuteScriptTool({
    executor: config.executor,
    ...(config.workspacePath !== undefined ? { workspacePath: config.workspacePath } : {}),
    ...(config.workspaceWrite !== undefined ? { workspaceWrite: config.workspaceWrite } : {}),
  });
  return {
    name: "code-executor",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[toolToken("execute_script") as string, tool]]);
    },
  };
}
