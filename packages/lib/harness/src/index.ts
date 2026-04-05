/**
 * @koi/harness — CLI harness assembly.
 *
 * Wire a KoiRuntime (or any HarnessRuntime) to a ChannelAdapter for
 * interactive REPL and single-prompt agent execution.
 */

export { createCliHarness } from "./harness.js";
export { renderEngineEvent, shouldRender } from "./render-event.js";
export type { CliHarness, CliHarnessConfig, HarnessRuntime } from "./types.js";
