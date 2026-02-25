/**
 * @koi/self-test — Agent E2E self-verification framework.
 *
 * Provides a composable, pre-deployment smoke test runner for Koi agents.
 * Validates manifests, middleware, tools, engine adapters, and E2E scenarios,
 * returning a machine-readable SelfTestReport.
 */

export { createSelfTest } from "./self-test.js";
export type {
  CheckCategory,
  CheckResult,
  CheckStatus,
  SelfTest,
  SelfTestConfig,
  SelfTestCustomCheck,
  SelfTestReport,
  SelfTestScenario,
  SelfTestTool,
} from "./types.js";
