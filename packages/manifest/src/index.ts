/**
 * @koi/manifest — YAML Agent Definition Loader (Layer 2)
 *
 * Reads koi.yaml files → interpolates env vars → parses YAML → validates via Zod →
 * transforms shorthand → returns typed LoadedManifest.
 *
 * Imports only from @koi/core (L0). No runtime dependencies beyond Zod.
 */

// Functions
export { loadManifest, loadManifestFromString } from "./loader.js";

// Types
export type { DeployConfig, LoadedManifest, LoadResult, ManifestWarning } from "./types.js";
