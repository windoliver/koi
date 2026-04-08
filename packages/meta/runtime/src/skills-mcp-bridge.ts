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
  let dirty = false;
  let version = 0;
  let inflight: Promise<void> | undefined;
  let unsubChange: (() => void) | undefined;

  const doSync = async (propagateError: boolean): Promise<void> => {
    if (disposed) return;

    const capturedVersion = ++version;

    try {
      const descriptors = await resolver.discover();

      // Only apply if still current and not disposed
      if (!disposed && capturedVersion === version) {
        const skills = descriptors.map(mapToolDescriptorToSkillMetadata);
        runtime.registerExternal(skills);
      }

      // Surface partial failures (servers that timed out / disconnected)
      if (resolver.failures.length > 0) {
        onSyncError?.(resolver.failures);
      }
    } catch (error: unknown) {
      // Clear stale skills on failure — don't advertise unreachable tools
      if (!disposed && capturedVersion === version) {
        runtime.registerExternal([]);
      }
      onSyncError?.(error);
      if (propagateError) {
        throw error;
      }
    }

    // Re-sync if onChange fired during our discover()
    if (dirty && !disposed) {
      dirty = false;
      await doSync(false);
    }
  };

  const syncFromResolver = (propagateError: boolean): Promise<void> => {
    if (disposed) return Promise.resolve();

    // If a sync is already in flight, concurrent callers join it
    if (inflight !== undefined) {
      dirty = true;
      // Concurrent callers join the existing promise (no early resolve)
      return propagateError ? inflight : inflight.catch(() => {});
    }

    inflight = doSync(propagateError).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  const sync = async (): Promise<void> => {
    // Subscribe before first discover so changes during sync set dirty flag
    if (unsubChange === undefined && !disposed && resolver.onChange !== undefined) {
      unsubChange = resolver.onChange(() => {
        void syncFromResolver(false);
      });
    }

    // Initial sync propagates errors so the caller can fail fast
    await syncFromResolver(true);
  };

  const dispose = (): void => {
    disposed = true;
    unsubChange?.();
    unsubChange = undefined;
    runtime.registerExternal([]);
  };

  return { sync, dispose };
}
