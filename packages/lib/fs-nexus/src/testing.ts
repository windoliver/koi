/**
 * @koi/fs-nexus/testing — Test utilities for filesystem backend testing.
 *
 * Separated from main export to avoid bun:test dependency in production builds.
 */

export { runFileSystemBackendContractTests } from "./contract-tests.js";
export type { FakeTransportOptions } from "./test-helpers.js";
export { createFakeNexusTransport } from "./test-helpers.js";
