/**
 * @koi/test-utils-contracts — Interface conformance contract test suites for Koi.
 *
 * Provides reusable contract test suites for validating EngineAdapter,
 * ChannelAdapter, Resolver, and Middleware implementations.
 */

export { runAgentRegistryContractTests } from "./agent-registry-contract.js";
export type { ChannelContractOptions } from "./channel-contract.js";
export { testChannelAdapter } from "./channel-contract.js";
export type { EngineContractOptions } from "./engine-contract.js";
export { testEngineAdapter } from "./engine-contract.js";
export { runHarnessContractTests } from "./harness-contract.js";
export type { MiddlewareContractOptions } from "./middleware-contract/index.js";
export { testMiddlewareContract } from "./middleware-contract/index.js";
export type { ResolverContractOptions } from "./resolver-contract.js";
export { testResolverContract } from "./resolver-contract.js";
