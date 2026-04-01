/**
 * @koi/scratchpad-local — Local in-memory ScratchpadComponent (Layer 2).
 *
 * Provides a fully-functional ScratchpadComponent with CAS, TTL, and
 * change events, backed by an in-memory Map.
 */

export { createLocalScratchpad } from "./scratchpad.js";
export type { LocalScratchpadConfig } from "./types.js";
