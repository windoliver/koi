/**
 * @koi/store-fs — Filesystem-backed ForgeStore for desktop/edge deployments.
 *
 * Hash-sharded directory layout with atomic write-temp-rename.
 * Hybrid metadata index: in-memory Map for fast search + on-demand disk reads.
 * 4-tier overlay for desktop: agent > shared > extensions > bundled.
 */

// extract bundled bricks
export type { ExtractBundledConfig, ExtractBundledResult } from "./extract-bundled.js";
export { extractBundled } from "./extract-bundled.js";
// single-directory store
export type { FsForgeStoreConfig, FsForgeStoreExtended } from "./fs-store.js";
export { createFsForgeStore } from "./fs-store.js";

// overlay store
export type { OverlayConfig, OverlayForgeStore } from "./overlay-store.js";
export { createOverlayForgeStore, overlayConfigFromHome } from "./overlay-store.js";
// tier definitions
export type { TierAccess, TierDescriptor, TierName } from "./tier.js";
export { isTierWritable, TIER_PRIORITY } from "./tier.js";
