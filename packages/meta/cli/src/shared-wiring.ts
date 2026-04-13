/**
 * Shared runtime-wiring helpers for `koi start` and `koi tui`.
 *
 * The two commands have independent runtime-assembly flows (different
 * tool stacks, different middleware ordering, different permission
 * defaults) but a handful of L2 subsystems are wired identically on
 * both sides. This module consolidates those pieces so neither command
 * drifts from the other and so the merging logic is tested in one place.
 *
 * Extracted here:
 *   - User MCP setup   (.mcp.json → resolver → provider [+ skills bridge])
 *   - Plugin MCP setup (activated plugins' mcpServers → resolver → provider)
 *   - User hook loading (~/.koi/hooks.json → tier-tagged RegisteredHook[])
 *   - User + plugin hook merging (tier-tagged, deterministic order)
 *
 * Intentionally NOT extracted: bash tool wiring (TUI uses
 * createBashToolWithHooks + elicit + trackCwd; `koi start` uses the
 * simpler createBashTool), permission backend construction (auto-allow
 * vs tiered rules), filesystem tools, and middleware composition order
 * — those are load-bearing differences between the two commands and
 * belong in the command files themselves.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ComponentProvider, HookConfig } from "@koi/core";
import type { RegisteredHook } from "@koi/hooks";
import { createRegisteredHooks, loadRegisteredHooks } from "@koi/hooks";
import type { McpResolver, McpServerConfig } from "@koi/mcp";
import { createMcpComponentProvider, createMcpResolver, loadMcpJsonFile } from "@koi/mcp";
import type { SkillsMcpBridge } from "@koi/runtime";
import { createSkillsMcpBridge } from "@koi/runtime";
import type { SkillsRuntime } from "@koi/skills-runtime";
import { createOAuthAwareMcpConnection } from "./mcp-connection-factory.js";

/** Common shape for an assembled MCP setup — user config or plugin-provided. */
export interface McpSetup {
  readonly resolver: McpResolver;
  readonly provider: ComponentProvider;
  /** Non-undefined only when a SkillsRuntime was supplied at construction. */
  readonly bridge: SkillsMcpBridge | undefined;
  /** Disposes the bridge (if any) and the underlying resolver. Idempotent. */
  readonly dispose: () => void;
}

/** Absolute path of `~/.koi/hooks.json` — the single user-tier hook source. */
export const USER_HOOKS_CONFIG_PATH: string = join(homedir(), ".koi", "hooks.json");

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

/**
 * Load `.mcp.json` from the given cwd and assemble an McpSetup.
 *
 * Returns undefined when the file is absent, unreadable, or declares no
 * servers — matching the prior behavior of both call sites (silent skip).
 * When a SkillsRuntime is provided, also wires a best-effort SkillsMcpBridge
 * so MCP tools become discoverable as skills; a failing bridge.sync() is
 * demoted to "no bridge" rather than a fatal error, again matching the
 * prior TUI behavior.
 */
export async function loadUserMcpSetup(
  cwd: string,
  skillsRuntime: SkillsRuntime | undefined,
): Promise<McpSetup | undefined> {
  const mcpConfigPath = join(cwd, ".mcp.json");
  const result = await loadMcpJsonFile(mcpConfigPath);
  if (!result.ok) return undefined;
  if (result.value.servers.length === 0) return undefined;

  const connections = result.value.servers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  const provider = createMcpComponentProvider({ resolver });

  let bridge: SkillsMcpBridge | undefined;
  if (skillsRuntime !== undefined) {
    bridge = createSkillsMcpBridge({ resolver, runtime: skillsRuntime });
    try {
      await bridge.sync();
    } catch {
      // Non-fatal — MCP tools just won't appear as skills for this session.
      bridge = undefined;
    }
  }

  return {
    resolver,
    provider,
    bridge,
    dispose: () => {
      bridge?.dispose();
      resolver.dispose();
    },
  };
}

/**
 * Assemble an McpSetup from the McpServerConfig list provided by activated
 * plugins. Returns undefined when no plugin declared any MCP servers. Plugin
 * setups never carry a SkillsRuntime bridge because plugins register their
 * skills through the separate SkillsRuntime.registerExternal pipeline.
 */
export function buildPluginMcpSetup(
  pluginMcpServers: readonly McpServerConfig[],
): McpSetup | undefined {
  if (pluginMcpServers.length === 0) return undefined;
  const connections = pluginMcpServers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  const provider = createMcpComponentProvider({ resolver });
  return {
    resolver,
    provider,
    bridge: undefined,
    dispose: () => {
      resolver.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Hook loading + merging
// ---------------------------------------------------------------------------

/**
 * Load user-tier hooks from `~/.koi/hooks.json` as tier-tagged
 * `RegisteredHook`s. Returns an empty array when the file is absent,
 * unreadable, or fails schema validation — matching the prior silent-skip
 * behavior of both call sites.
 *
 * When `filterAgentHooks` is true, any `kind: "agent"` hooks are removed
 * (and their names reported via the optional callback) so the caller can
 * warn the operator. Agent hooks require a spawnFn that the TUI does not
 * provide — the same filter applied before this helper existed.
 */
export async function loadUserRegisteredHooks(options: {
  readonly filterAgentHooks: boolean;
  readonly onAgentHooksFiltered?: (hookNames: readonly string[]) => void;
}): Promise<readonly RegisteredHook[]> {
  let raw: unknown;
  try {
    raw = await Bun.file(USER_HOOKS_CONFIG_PATH).json();
  } catch {
    return [];
  }
  const result = loadRegisteredHooks(raw, "user");
  if (!result.ok) return [];
  if (!options.filterAgentHooks) return result.value;
  const agentHooks = result.value.filter((rh) => rh.hook.kind === "agent");
  if (agentHooks.length > 0 && options.onAgentHooksFiltered !== undefined) {
    options.onAgentHooksFiltered(agentHooks.map((rh) => rh.hook.name));
  }
  return result.value.filter((rh) => rh.hook.kind !== "agent");
}

/**
 * Merge already-loaded user-tier hooks with plugin-provided `HookConfig`s
 * (tier-tagged as "session"), returning a single deterministic list in
 * user-then-plugin order. When `filterAgentHooks` is true, `kind: "agent"`
 * plugin hooks are silently dropped to mirror the user-hook filter applied
 * by `loadUserRegisteredHooks`.
 */
export function mergeUserAndPluginHooks(
  userHooks: readonly RegisteredHook[],
  pluginHookConfigs: readonly HookConfig[],
  options: { readonly filterAgentHooks: boolean },
): readonly RegisteredHook[] {
  const filteredPluginConfigs = options.filterAgentHooks
    ? pluginHookConfigs.filter((h) => h.kind !== "agent")
    : pluginHookConfigs;
  const pluginRegistered = createRegisteredHooks(filteredPluginConfigs, "session");
  return [...userHooks, ...pluginRegistered];
}
