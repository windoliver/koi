/**
 * Skills-MCP bridge — connects McpResolver tool discovery to SkillsRuntime.
 *
 * Maps MCP ToolDescriptor[] → SkillMetadata[] with source: "mcp" and registers
 * them via registerExternal(). Subscribes to resolver onChange for live updates.
 *
 * Race-safe: serialized sync with disposed/dirty guards prevents stale writes.
 *
 * Single-owner constraint: registerExternal() uses full-replacement semantics,
 * so only ONE bridge instance (or external-skill producer) should own a given
 * SkillsRuntime's external slot. Multiple bridges on the same runtime will
 * overwrite each other. If multi-source external skills are needed, compose
 * them upstream and feed a single registerExternal() call.
 */

import type { ToolDescriptor } from "@koi/core";
import type { McpResolver } from "@koi/mcp";
import type { SkillMetadata, SkillsRuntime } from "@koi/skills-runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillsMcpBridgeConfig {
  readonly resolver: McpResolver;
  readonly runtime: SkillsRuntime;
  /** Called when a refresh fails. The bridge clears stale skills on failure. */
  readonly onSyncError?: (error: unknown) => void;
}

export interface SkillsMcpBridge {
  /** Perform initial discovery, register MCP tools as skills, and subscribe to changes. */
  readonly sync: () => Promise<void>;
  /** Unsubscribe from change notifications and clear all MCP skills. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Maps a single MCP ToolDescriptor to a SkillMetadata entry. */
export function mapToolDescriptorToSkillMetadata(descriptor: ToolDescriptor): SkillMetadata {
  const server = descriptor.server ?? undefined;
  const baseTags: readonly string[] = server !== undefined ? ["mcp", server] : ["mcp"];
  const tags: readonly string[] =
    descriptor.tags !== undefined ? [...baseTags, ...descriptor.tags] : baseTags;

  return {
    name: descriptor.name,
    description: descriptor.description,
    source: "mcp",
    dirPath: `mcp://${server ?? "unknown"}`,
    tags,
  };
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

export function createSkillsMcpBridge(config: SkillsMcpBridgeConfig): SkillsMcpBridge {
  const { resolver, runtime, onSyncError } = config;

  let disposed = false;
  let syncInFlight = false;
  let dirty = false;
  let version = 0;
  let unsubChange: (() => void) | undefined;

  const syncFromResolver = async (): Promise<void> => {
    if (disposed || syncInFlight) {
      if (syncInFlight) {
        dirty = true;
      }
      return;
    }

    syncInFlight = true;
    const capturedVersion = ++version;

    try {
      const descriptors = await resolver.discover();

      // Only apply if still current and not disposed
      if (!disposed && capturedVersion === version) {
        const skills = descriptors.map(mapToolDescriptorToSkillMetadata);
        runtime.registerExternal(skills);
      }
    } catch (error: unknown) {
      // Clear stale skills on failure — don't advertise unreachable tools
      if (!disposed && capturedVersion === version) {
        runtime.registerExternal([]);
      }
      onSyncError?.(error);
    } finally {
      syncInFlight = false;
    }

    // Re-sync if onChange fired during our discover()
    if (dirty && !disposed) {
      dirty = false;
      await syncFromResolver();
    }
  };

  const sync = async (): Promise<void> => {
    // Subscribe before first discover so changes during sync set dirty flag
    if (unsubChange === undefined && !disposed && resolver.onChange !== undefined) {
      unsubChange = resolver.onChange(() => {
        void syncFromResolver();
      });
    }

    await syncFromResolver();
  };

  const dispose = (): void => {
    disposed = true;
    unsubChange?.();
    unsubChange = undefined;
    runtime.registerExternal([]);
  };

  return { sync, dispose };
}
