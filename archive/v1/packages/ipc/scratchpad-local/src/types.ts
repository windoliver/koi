/**
 * Configuration types for the local scratchpad.
 */

import type { AgentGroupId, AgentId } from "@koi/core";

/** Configuration for createLocalScratchpad. */
export interface LocalScratchpadConfig {
  /** Group scope for the scratchpad. */
  readonly groupId: AgentGroupId;
  /** Author agent ID. */
  readonly authorId: AgentId;
  /** Periodic sweep interval in milliseconds. Default: 60_000. */
  readonly sweepIntervalMs?: number | undefined;
}
