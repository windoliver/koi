/**
 * @koi/demo-packs — programmatic seeders for demo runtime state.
 */

export { getPack, listPacks, PACK_IDS, runSeed } from "./seed.js";
export type {
  AgentLifecycle,
  AgentRole,
  DemoPack,
  SeedContext,
  SeededBrickView,
  SeedResult,
} from "./types.js";
