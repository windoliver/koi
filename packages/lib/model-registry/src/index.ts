/**
 * @koi/model-registry — Per-model context window registry (L0-utility)
 *
 * Zero deps. Pure data + pure functions. Importable by L1 and any L2 package.
 */

export type { KnownModelId } from "./registry.js";
export {
  DEFAULT_MODEL_WINDOW,
  isKnownModel,
  MODEL_WINDOWS,
  resolveModelWindow,
} from "./registry.js";
