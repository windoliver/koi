export { createVercelAdapter, VERCEL_ADAPTER_VERSION } from "./adapter.js";
export type { MockKvHandle } from "./kv-mock.js";
export { createMockKv } from "./kv-mock.js";
export type {
  ClaimOutcome,
  ClaimRequest,
  KvCommandRunner,
} from "./kv-state-machine.js";
export {
  claim,
  commit,
  commitFail,
  extendLease,
  releaseTransient,
} from "./kv-state-machine.js";
export { mapShimResponse } from "./map-shim-response.js";
export type { CanonicalSignInput, PairKeypair } from "./pair-keys.js";
export {
  buildCanonicalSigningString,
  generatePairKeypair,
  signRequest,
  verifyRequest,
} from "./pair-keys.js";
export { GATEWAY_SHIM_SOURCE, HANDLER_RUNNER_SHIM_SOURCE } from "./shim-templates.js";
export type { VercelAdapterConfig } from "./types.js";
export { validateVercelAdapterConfig } from "./validate.js";
