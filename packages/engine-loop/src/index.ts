/**
 * @koi/engine-loop — ReAct loop engine adapter (Layer 2).
 *
 * A pure TypeScript implementation of the EngineAdapter contract that runs
 * a Reason + Act cycle: call the model, check for tool calls, execute them
 * in parallel, append results, and repeat.
 */

export type { LoopAdapterConfig } from "./loop-adapter.js";
export { createLoopAdapter } from "./loop-adapter.js";
