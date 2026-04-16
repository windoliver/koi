/**
 * Plugin activation — discovers enabled plugins and aggregates their
 * hooks, MCP servers, skill paths, and middleware names for session wiring.
 *
 * This module lives in the CLI meta-package (not @koi/plugins L2) because
 * it imports from multiple L2 packages (@koi/hooks, @koi/mcp, @koi/skills-runtime).
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HookConfig } from "@koi/core";
import { loadHooks } from "@koi/hooks";
import type { McpServerConfig } from "@koi/mcp";
import { loadMcpJsonFile } from "@koi/mcp";
import { createGatedRegistry } from "@koi/plugins";
import type { SkillMetadata } from "@koi/skills-runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPluginInfo {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: "bundled" | "user" | "managed";
}

export interface PluginComponents {
  readonly hooks: readonly HookConfig[];
  readonly mcpServers: readonly McpServerConfig[];
  readonly skillMetadata: readonly SkillMetadata[];
  readonly middlewareNames: readonly string[];
  readonly errors: readonly PluginActivationError[];
  /** Discovered plugin metadata (name, version, description, source). */
  readonly discovered: readonly DiscoveredPluginInfo[];
}

/** Plugin discovery summary for host consumption (TUI, headless, etc.). */
export interface PluginDiscoverySummary {
  readonly loaded: readonly DiscoveredPluginInfo[];
  readonly errors: readonly PluginActivationError[];
}

export interface PluginActivationError {
  readonly plugin: string;
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_FILE = "SKILL.md";

// ---------------------------------------------------------------------------
// Skill loading helpers
// ---------------------------------------------------------------------------

/**
 * Reads a SKILL.md file and extracts minimal SkillMetadata.
 * Returns undefined if the file is missing or has no valid frontmatter.
 */
async function readPluginSkillMeta(dirPath: string): Promise<SkillMetadata | undefined> {
  const skillMdPath = join(dirPath, SKILL_FILE);
  let content: string;
  try {
    content = await readFile(skillMdPath, "utf-8");
  } catch {
    return undefined;
  }

  // Extract YAML frontmatter between --- markers
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (match?.[1] === undefined) return undefined;

  // Parse simple key: value pairs from frontmatter
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      if (key.length > 0 && value.length > 0) {
        meta[key] = value;
      }
    }
  }

  const name = meta.name ?? basename(dirPath);
  const description = meta.description ?? "";

  return {
    name,
    description,
    source: "user" as const,
    dirPath,
  };
}

/**
 * Scans a skill root directory for subdirectories containing SKILL.md.
 * Returns SkillMetadata for each valid skill found.
 */
async function loadSkillsFromRoot(rootPath: string): Promise<readonly SkillMetadata[]> {
  // Check if rootPath itself is a skill dir (has SKILL.md directly)
  const directMeta = await readPluginSkillMeta(rootPath);
  if (directMeta !== undefined) return [directMeta];

  // Otherwise scan subdirectories
  let entries: string[];
  try {
    const dirents = await readdir(rootPath, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  const results: SkillMetadata[] = [];
  for (const entry of entries) {
    const meta = await readPluginSkillMeta(join(rootPath, entry));
    if (meta !== undefined) results.push(meta);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discovers enabled plugins and aggregates their components for session wiring.
 * Errors are collected per-plugin and never thrown.
 *
 * When `options.allowlist` is supplied, only plugins whose name appears in
 * the set are activated — everything else discovered in `userRoot` is
 * skipped silently. Manifest-driven opt-in uses this to let operators
 * declare exactly which plugins their `koi.yaml` pulls in:
 *
 *   # koi.yaml
 *   plugins:
 *     - my-hook-bundle
 *     - my-mcp-server
 *
 * When `allowlist` is omitted (default), all discovered plugins are
 * activated — matching the prior filesystem-scan auto-discovery
 * behavior so existing hosts without a `plugins:` field keep working.
 *
 * Passing `allowlist: new Set()` explicitly deactivates every plugin —
 * useful for CI runs that want a reproducible minimal assembly.
 */
export async function loadPluginComponents(
  userRoot: string,
  options?: { readonly allowlist?: ReadonlySet<string> | undefined },
): Promise<PluginComponents> {
  const allowlist = options?.allowlist;
  const hooks: HookConfig[] = [];
  const mcpServers: McpServerConfig[] = [];
  const skillMetadata: SkillMetadata[] = [];
  const middlewareNames: string[] = [];
  const errors: PluginActivationError[] = [];

  const registry = createGatedRegistry({ userRoot }, userRoot);
  const plugins = await registry.discover();

  const discovered: DiscoveredPluginInfo[] = [];

  for (const pluginMeta of plugins) {
    if (allowlist !== undefined && !allowlist.has(pluginMeta.name)) continue;

    const loadResult = await registry.load(pluginMeta.name);
    if (!loadResult.ok) {
      errors.push({ plugin: pluginMeta.name, error: loadResult.error.message });
      continue;
    }
    const plugin = loadResult.value;

    // Buffer per-plugin components locally for atomic activation.
    // Only merge into the runtime if ALL activation steps succeed.
    const pluginHooks: HookConfig[] = [];
    const pluginMcpServers: McpServerConfig[] = [];
    const pluginSkills: SkillMetadata[] = [];
    const pluginErrors: PluginActivationError[] = [];

    // Hooks
    if (plugin.hookConfigPath !== undefined) {
      try {
        const raw: unknown = await Bun.file(plugin.hookConfigPath).json();
        const hookResult = loadHooks(raw);
        if (hookResult.ok) {
          pluginHooks.push(...hookResult.value);
        } else {
          pluginErrors.push({
            plugin: plugin.name,
            error: `Hook load failed: ${hookResult.error.message}`,
          });
        }
      } catch (err: unknown) {
        pluginErrors.push({
          plugin: plugin.name,
          error: `Cannot read hook config: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // MCP servers
    if (plugin.mcpConfigPath !== undefined) {
      const mcpResult = await loadMcpJsonFile(plugin.mcpConfigPath);
      if (mcpResult.ok) {
        pluginMcpServers.push(...mcpResult.value.servers);
      } else {
        pluginErrors.push({
          plugin: plugin.name,
          error: `MCP load failed: ${mcpResult.error.message}`,
        });
      }
    }

    // Skills
    for (const skillPath of plugin.skillPaths) {
      const skills = await loadSkillsFromRoot(skillPath);
      pluginSkills.push(...skills);
    }

    // Middleware references are not yet resolvable (no factory registry).
    // Treat declared middleware as an activation error so plugins that
    // depend on middleware enforcement are not reported as fully loaded.
    if (plugin.middlewareNames.length > 0) {
      pluginErrors.push({
        plugin: plugin.name,
        error: `Middleware not supported (no factory registry): ${plugin.middlewareNames.join(", ")}`,
      });
    }

    // Atomic commit: merge only if all activation steps succeeded
    if (pluginErrors.length === 0) {
      hooks.push(...pluginHooks);
      mcpServers.push(...pluginMcpServers);
      skillMetadata.push(...pluginSkills);
      discovered.push({
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        source: plugin.source,
      });
    } else {
      errors.push(...pluginErrors);
    }
  }

  return { hooks, mcpServers, skillMetadata, middlewareNames, errors, discovered };
}
