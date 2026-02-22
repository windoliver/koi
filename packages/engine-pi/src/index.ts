/**
 * @koi/engine-pi — pi-agent-core engine adapter (Layer 2)
 *
 * Wraps @mariozechner/pi-agent-core as a Koi EngineAdapter with full
 * middleware interposition on both model calls and tool calls.
 */

export { createPiAdapter } from "./adapter.js";
export type {
  ContextMessage,
  GetApiKeyFn,
  PiAdapterConfig,
  PiEngineAdapter,
  ThinkingLevel,
  TransformContextFn,
} from "./types.js";
