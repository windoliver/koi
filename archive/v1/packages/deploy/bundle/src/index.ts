/**
 * @koi/bundle — Portable agent export/import bundles (Layer 2).
 *
 * Docker-style export/import for Koi agents: serialize an agent's manifest +
 * referenced bricks into a `.koibundle` JSON file, import into another
 * deployment with integrity verification, deduplication, and trust downgrading.
 */

export { createBundle } from "./export-bundle.js";
export { importBundle } from "./import-bundle.js";
export { deserializeBundle, serializeBundle } from "./serialize.js";
export type {
  ExportBundleConfig,
  ImportBrickError,
  ImportBundleConfig,
  ImportBundleResult,
} from "./types.js";
