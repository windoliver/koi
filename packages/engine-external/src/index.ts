/**
 * @koi/engine-external — External process engine adapter (Layer 2)
 *
 * Wraps any external process as an EngineAdapter via Bun.spawn().
 * Supports single-shot, long-lived, and PTY modes with pluggable output parsers.
 */

export { createExternalAdapter } from "./adapter.js";
export { descriptor } from "./descriptor.js";
export {
  createJsonLinesParser,
  createLineParser,
  createTextDeltaParser,
} from "./parsers.js";
export type {
  EnvStrategy,
  ExternalAdapterConfig,
  ExternalEngineAdapter,
  ExternalProcessState,
  ManagedProcess,
  OutputParseResult,
  OutputParser,
  OutputParserFactory,
  PipedProcess,
  PtyConfig,
  PtyProcess,
  ShutdownConfig,
} from "./types.js";
export { validateExternalAdapterConfig } from "./validate-config.js";
