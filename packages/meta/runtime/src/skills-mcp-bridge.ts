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

/**
 * Sanitizes an MCP-controlled string to only contain safe characters.
 * Strips anything that isn't alphanumeric, underscore, hyphen, or dot.
 * This prevents prompt injection via tool names or server names that
 * flow into the capability banner or SkillMetadata keys.
 */
function sanitizeMcpName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 128);
}

/**
 * Maps a single MCP ToolDescriptor to a SkillMetadata entry.
 *
 * Security: all MCP-controlled strings are sanitized before use.
 * - name: stripped to safe characters (alphanumeric, underscore, hyphen, dot)
 * - description: constant string — raw MCP descriptions never flow into the
 *   system prompt (external skills bypass the skill scanner)
 * - server/tags: sanitized
 */
export function mapToolDescriptorToSkillMetadata(descriptor: ToolDescriptor): SkillMetadata {
  const sanitizedName = sanitizeMcpName(descriptor.name);
  const server = descriptor.server !== undefined ? sanitizeMcpName(descriptor.server) : undefined;
  const baseTags: readonly string[] = server !== undefined ? ["mcp", server] : ["mcp"];
  const tags: readonly string[] =
    descriptor.tags !== undefined
      ? [...baseTags, ...descriptor.tags.map(sanitizeMcpName)]
      : baseTags;

  return {
    name: sanitizedName,
    // Empty description: MCP skills are metadata-only (discovery/querying).
    // External skill body = description, which gets injected into the system
    // prompt. Empty string avoids N copies of identical filler per MCP tool.
    description: "",
    source: "mcp",
    dirPath: `mcp://${server ?? "unknown"}`,
    tags,
  };
}

export interface MapToolDescriptorsResult {
  readonly skills: readonly SkillMetadata[];
  readonly skipped: readonly string[];
}

/**
 * Maps descriptors to SkillMetadata, deduplicating after sanitization.
 * Skips descriptors whose sanitized name is empty or collides with an
 * earlier entry. Reports skipped names for telemetry/warnings.
 */
export function mapToolDescriptorsToSkillMetadata(
  descriptors: readonly ToolDescriptor[],
): MapToolDescriptorsResult {
  const seen = new Set<string>();
  const skills: SkillMetadata[] = [];
  const skipped: string[] = [];

  for (const d of descriptors) {
    const mapped = mapToolDescriptorToSkillMetadata(d);
    if (mapped.name === "") {
      skipped.push(d.name);
      continue;
    }
    if (seen.has(mapped.name)) {
      skipped.push(d.name);
      continue;
    }
    seen.add(mapped.name);
    skills.push(mapped);
  }

  return { skills, skipped };
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

    // Clear dirty before starting — only flags set during discover() trigger re-sync
    dirty = false;
    const capturedVersion = ++version;

    try {
      const descriptors = await resolver.discover();

      // Only apply if still current and not disposed
      if (!disposed && capturedVersion === version) {
        const { skills, skipped } = mapToolDescriptorsToSkillMetadata(descriptors);
        runtime.registerExternal(skills);

        // Surface skipped tools from sanitization collisions
        if (skipped.length > 0) {
          onSyncError?.({ kind: "sanitization-collision", skipped });
        }
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
      return propagateError ? inflight : inflight.catch(() => {});
    }

    inflight = doSync(propagateError).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  /** onChange handler: marks dirty (to trigger re-sync) and joins/starts sync. */
  const onChangeHandler = (): void => {
    if (disposed) return;
    // Mark dirty so doSync re-syncs after the current in-flight completes
    dirty = true;
    void syncFromResolver(false);
  };

  const sync = async (): Promise<void> => {
    // Subscribe before first discover so changes during sync set dirty flag
    if (unsubChange === undefined && !disposed && resolver.onChange !== undefined) {
      unsubChange = resolver.onChange(onChangeHandler);
    }

    try {
      // Initial sync propagates errors so the caller can fail fast
      await syncFromResolver(true);
    } catch (error: unknown) {
      // Unsubscribe on failed initial sync — don't leave a stale listener
      unsubChange?.();
      unsubChange = undefined;
      throw error;
    }
  };

  const dispose = (): void => {
    disposed = true;
    unsubChange?.();
    unsubChange = undefined;
    runtime.registerExternal([]);
  };

  return { sync, dispose };
}
