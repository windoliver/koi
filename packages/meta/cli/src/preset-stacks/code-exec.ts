/**
 * Code-exec preset stack — the `execute_code` tool from @koi/tool-exec.
 *
 * Runs model-authored TypeScript/JavaScript in an isolated Bun Worker.
 * This initial wiring exposes pure-JS execution only — scripts cannot
 * call other tools via `tools.*` yet. Wiring `callTool` through the
 * middleware chain (permissions, hooks, audit) so inner tool calls are
 * gated is deferred to a follow-up.
 *
 * The trust gate (ACKNOWLEDGE_UNSANDBOXED_EXECUTION) is satisfied here
 * on behalf of the TUI/CLI host. Scripts run with the host process's
 * ambient Bun capabilities (fetch, Bun.file, timers); operators who
 * don't want this behavior can exclude the stack from their preset set.
 */

import { createSingleToolProvider } from "@koi/core";
import { ACKNOWLEDGE_UNSANDBOXED_EXECUTION, createExecuteCodeTool } from "@koi/tool-exec";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

export const codeExecStack: PresetStack = {
  id: "code-exec",
  description: "TypeScript/JavaScript script execution via the execute_code tool",
  activate: (): StackContribution => {
    const toolResult = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACKNOWLEDGE_UNSANDBOXED_EXECUTION,
      tools: new Map(),
    });
    if (!toolResult.ok) {
      throw new Error(`code-exec stack: createExecuteCodeTool failed: ${toolResult.error.message}`);
    }
    const tool = toolResult.value;
    return {
      middleware: [],
      providers: [
        createSingleToolProvider({
          name: "execute-code",
          toolName: "execute_code",
          createTool: () => tool,
        }),
      ],
    };
  },
};
