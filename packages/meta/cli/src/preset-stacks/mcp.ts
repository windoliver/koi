/**
 * MCP preset stack — user `.mcp.json` + plugin-provided MCP servers.
 *
 * This stack is the single place the runtime touches Model Context
 * Protocol configuration. It:
 *
 *   - Loads the user's `.mcp.json` from `ctx.cwd` via
 *     `loadUserMcpSetup`, binding the SkillsRuntime (if supplied via
 *     `ctx.host.skillsRuntime`) so MCP-discovered tools also appear
 *     as skills in the Skill meta-tool resolver.
 *   - Builds a separate MCP setup for plugin-declared servers via
 *     `buildPluginMcpSetup`, reading the server list from
 *     `ctx.host[PLUGIN_MCP_SERVERS_HOST_KEY]`. Plugin activation
 *     (loading the plugin config itself) stays in the factory because
 *     it feeds BOTH the hook list and the MCP server list — it's
 *     pre-stack host bootstrap, not a stack feature.
 *   - Contributes both resolver providers to the runtime.
 *   - Registers `onShutdown` cleanup for both setups; the factory
 *     calls `shutdownBackgroundTasks()` on host exit which fans out
 *     to every stack's `onShutdown`, so the MCP disposers run
 *     alongside the execution stack's bgController abort.
 */

import type { McpServerConfig } from "@koi/mcp";
import type { SkillsRuntime } from "@koi/skills-runtime";
import type { PresetStack, StackContribution } from "../preset-stacks.js";
import { buildPluginMcpSetup, loadUserMcpSetup } from "../shared-wiring.js";

/** Key under `ctx.host` for the `SkillsRuntime` (when the host supplies one). */
export const SKILLS_RUNTIME_MCP_HOST_KEY = "skillsRuntime";
/** Key under `ctx.host` for the plugin-provided MCP server list. */
export const PLUGIN_MCP_SERVERS_HOST_KEY = "pluginMcpServers";

export const mcpStack: PresetStack = {
  id: "mcp",
  description:
    "Model Context Protocol — user .mcp.json + plugin-provided servers (with lifecycle dispose)",
  activate: async (ctx): Promise<StackContribution> => {
    const skillsRuntime = ctx.host?.[SKILLS_RUNTIME_MCP_HOST_KEY] as SkillsRuntime | undefined;
    const pluginMcpServers =
      (ctx.host?.[PLUGIN_MCP_SERVERS_HOST_KEY] as readonly McpServerConfig[] | undefined) ?? [];

    const userMcpSetup = await loadUserMcpSetup(ctx.cwd, skillsRuntime);
    const pluginMcpSetup = buildPluginMcpSetup(pluginMcpServers);

    return {
      middleware: [],
      providers: [
        ...(userMcpSetup !== undefined ? [userMcpSetup.provider] : []),
        ...(pluginMcpSetup !== undefined ? [pluginMcpSetup.provider] : []),
      ],
      exports: {
        ...(userMcpSetup !== undefined ? { mcpResolver: userMcpSetup.resolver } : {}),
      },
      onShutdown: () => {
        // Best-effort dispose. Neither setup has background work that
        // would block exit — they hold connection pools whose
        // teardown is synchronous. Return `false` because the
        // shutdown hook's boolean is reserved for "had live processes
        // that need SIGKILL escalation window"; MCP cleanup is
        // instant.
        userMcpSetup?.dispose();
        pluginMcpSetup?.dispose();
        return false;
      },
    };
  },
};
