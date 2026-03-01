/**
 * compact_context tool — lets the agent proactively trigger context compaction.
 *
 * The tool sets a one-shot flag via scheduleCompaction(); the compactor
 * middleware consumes it on the next wrapModelCall/wrapModelStream.
 */

import type { JsonObject, Tool, ToolDescriptor, ToolExecuteOptions, TrustTier } from "@koi/core";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CompactContextToolDeps {
  readonly scheduleCompaction: () => void;
  readonly formatOccupancy: () => string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCompactContextTool(deps: CompactContextToolDeps): Tool {
  const descriptor: ToolDescriptor = {
    name: "compact_context",
    description:
      "Schedule early context compaction. " +
      "Call when context occupancy is high and you want to free space before hitting the automatic threshold.",
    inputSchema: { type: "object", properties: {} } satisfies JsonObject,
  };

  const trustTier: TrustTier = "verified";

  return {
    descriptor,
    trustTier,
    async execute(_args: JsonObject, _options?: ToolExecuteOptions): Promise<string> {
      deps.scheduleCompaction();
      const occupancy = deps.formatOccupancy();
      return `Compaction scheduled for next model call. Current ${occupancy}.`;
    },
  };
}
