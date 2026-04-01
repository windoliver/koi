/**
 * @koi/scratchpad-nexus — Group-scoped versioned file store backed by Nexus.
 *
 * L2 package. Depends on @koi/core (L0) and @koi/nexus-client (L0u).
 */

// Re-export L0 types for convenience
export type {
  AgentGroupId,
  ScratchpadChangeEvent,
  ScratchpadComponent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadFilter,
  ScratchpadGeneration,
  ScratchpadPath,
  ScratchpadWriteInput,
  ScratchpadWriteResult,
} from "@koi/core";

// Package exports
export type { ScratchpadOperation } from "./constants.js";
export type { ScratchpadClient } from "./scratchpad-client.js";
export { createScratchpadClient } from "./scratchpad-client.js";
export type {
  ScratchpadNexusProviderConfig,
  ScratchpadNexusProviderResult,
} from "./scratchpad-provider.js";
export { createScratchpadNexusProvider } from "./scratchpad-provider.js";
