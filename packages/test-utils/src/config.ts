/**
 * Config test helpers — factory functions for test fixtures.
 */

import type { ConfigStore, ConfigUnsubscribe, KoiConfig } from "@koi/core";

/**
 * Default KoiConfig for tests. All values are sensible defaults.
 */
const TEST_KOI_CONFIG: KoiConfig = Object.freeze({
  logLevel: "silent",
  telemetry: Object.freeze({ enabled: false }),
  limits: Object.freeze({ maxTurns: 5, maxDurationMs: 10_000, maxTokens: 10_000 }),
  loopDetection: Object.freeze({ enabled: true, windowSize: 4, threshold: 2 }),
  spawn: Object.freeze({ maxDepth: 2, maxFanOut: 3, maxTotalProcesses: 10 }),
  forge: Object.freeze({
    enabled: false,
    maxForgeDepth: 0,
    maxForgesPerSession: 1,
    defaultScope: "agent",
    defaultTrustTier: "sandbox",
  }),
  modelRouter: Object.freeze({
    strategy: "fallback",
    targets: Object.freeze([Object.freeze({ provider: "test", model: "test-model" })]),
  }),
  features: Object.freeze({}),
});

/**
 * Creates a KoiConfig for testing with optional overrides.
 *
 * Uses minimal/safe defaults (logLevel=silent, low limits, forge disabled).
 */
export function createTestConfig(overrides?: Partial<KoiConfig>): KoiConfig {
  if (overrides === undefined) {
    return TEST_KOI_CONFIG;
  }
  return { ...TEST_KOI_CONFIG, ...overrides };
}

/**
 * Creates a fake ConfigStore<KoiConfig> for testing.
 *
 * Returns a fixed config and a no-op subscribe. Useful when code requires
 * a ConfigStore but you don't need reactivity in tests.
 */
export function createTestConfigStore(overrides?: Partial<KoiConfig>): ConfigStore<KoiConfig> {
  const config = createTestConfig(overrides);
  return {
    get: () => config,
    subscribe: (): ConfigUnsubscribe => () => {},
  };
}
