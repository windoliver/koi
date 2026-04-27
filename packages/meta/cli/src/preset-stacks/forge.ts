/**
 * Forge preset stack — primordial brick synthesis + discovery + inspection.
 *
 * Contributes four providers from @koi/forge-tools backed by a single
 * in-process in-memory ForgeStore:
 *
 *   - forge_tool       — synthesize a `tool` brick (sandboxed runner)
 *   - forge_middleware — synthesize a `middleware` brick (unsandboxed runner)
 *   - forge_list       — list bricks visible to the caller (own agent + active globals)
 *   - forge_inspect    — read a single brick by content-addressed BrickId
 *
 * The ForgeStore is process-scoped and ephemeral: bricks live for the lifetime
 * of the runtime and are lost on restart. A persistent backend is a separate
 * follow-up; this stack exists to expose synthesis to the LLM in long-running
 * interactive hosts (TUI, daemon) where ephemeral storage is acceptable.
 */

import { createSingleToolProvider } from "@koi/core";
import {
  createForgeInspectTool,
  createForgeListTool,
  createForgeMiddlewareTool,
  createForgeToolTool,
  createInMemoryForgeStore,
} from "@koi/forge-tools";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

export const forgeStack: PresetStack = {
  id: "forge",
  description: "Forge tool synthesis: forge_tool, forge_middleware, forge_list, forge_inspect",
  activate: (): StackContribution => {
    const store = createInMemoryForgeStore();
    return {
      middleware: [],
      providers: [
        createSingleToolProvider({
          name: "forge-tool",
          toolName: "forge_tool",
          createTool: () => createForgeToolTool({ store }),
        }),
        createSingleToolProvider({
          name: "forge-middleware",
          toolName: "forge_middleware",
          createTool: () => createForgeMiddlewareTool({ store }),
        }),
        createSingleToolProvider({
          name: "forge-list",
          toolName: "forge_list",
          createTool: () => createForgeListTool({ store }),
        }),
        createSingleToolProvider({
          name: "forge-inspect",
          toolName: "forge_inspect",
          createTool: () => createForgeInspectTool({ store }),
        }),
      ],
    };
  },
};
