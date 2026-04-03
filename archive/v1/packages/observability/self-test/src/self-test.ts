/**
 * createSelfTest — factory for the self-test runner.
 *
 * Orchestrates check categories sequentially, aggregates results,
 * and returns a machine-readable SelfTestReport.
 */

import { KoiRuntimeError } from "@koi/errors";
import { createMockSessionContext } from "@koi/test-utils";
import { runCheck, skipCheck } from "./check-runner.js";
import { runEngineChecks } from "./checks/engine-checks.js";
import { runManifestChecks } from "./checks/manifest-checks.js";
import { runMiddlewareChecks } from "./checks/middleware-checks.js";
import { runScenarioChecks } from "./checks/scenario-checks.js";
import { runToolChecks } from "./checks/tool-checks.js";
import type {
  CheckCategory,
  CheckResult,
  SelfTest,
  SelfTestConfig,
  SelfTestReport,
} from "./types.js";

const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 30_000;

const CATEGORY_ORDER: readonly CheckCategory[] = [
  "manifest",
  "middleware",
  "tools",
  "engine",
  "scenarios",
  "custom",
];

/**
 * Create a self-test runner from the given config.
 *
 * @throws KoiRuntimeError with code VALIDATION if config is structurally invalid.
 */
export function createSelfTest(config: SelfTestConfig): SelfTest {
  if (config.manifest === undefined || config.manifest === null) {
    throw KoiRuntimeError.from("VALIDATION", "SelfTestConfig.manifest is required");
  }

  const checkTimeoutMs = config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const globalTimeoutMs = config.timeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS;
  const failFast = config.failFast ?? false;
  const categorySet = new Set(config.categories ?? CATEGORY_ORDER);

  return {
    async run(): Promise<SelfTestReport> {
      const globalStart = Date.now();
      // Local mutable array for sequential accumulation
      const allChecks: CheckResult[] = [];

      for (const category of CATEGORY_ORDER) {
        if (!categorySet.has(category)) continue;

        // Global timeout: skip remaining categories
        if (Date.now() - globalStart >= globalTimeoutMs) {
          allChecks.push(
            skipCheck(
              `${category}: skipped (global timeout)`,
              category,
              `Global timeout of ${String(globalTimeoutMs)}ms exceeded`,
            ),
          );
          continue;
        }

        // Fail-fast: skip if any previous check failed
        if (failFast && allChecks.some((c) => c.status === "fail")) {
          allChecks.push(
            skipCheck(
              `${category}: skipped (failFast)`,
              category,
              "Previous category had failures and failFast is enabled",
            ),
          );
          continue;
        }

        const categoryResults = await runCategory(category, config, checkTimeoutMs);
        for (const result of categoryResults) {
          allChecks.push(result);
        }
      }

      const passed = allChecks.filter((c) => c.status === "pass").length;
      const failed = allChecks.filter((c) => c.status === "fail").length;
      const skipped = allChecks.filter((c) => c.status === "skip").length;

      return {
        passed,
        failed,
        skipped,
        totalDurationMs: Date.now() - globalStart,
        checks: allChecks,
        healthy: failed === 0,
      };
    },
  };
}

async function runCategory(
  category: CheckCategory,
  config: SelfTestConfig,
  checkTimeoutMs: number,
): Promise<readonly CheckResult[]> {
  switch (category) {
    case "manifest":
      return runManifestChecks(config.manifest, checkTimeoutMs);

    case "middleware":
      return runMiddlewareChecks(
        config.middleware ?? [],
        () => createMockSessionContext(),
        checkTimeoutMs,
      );

    case "tools":
      return runToolChecks(config.tools ?? [], checkTimeoutMs);

    case "engine": {
      if (config.adapter === undefined) {
        return [skipCheck("engine: skipped", "engine", "No adapter provided")];
      }
      return runEngineChecks(config.adapter, checkTimeoutMs);
    }

    case "scenarios": {
      if (config.scenarios === undefined || config.scenarios.length === 0) {
        return [skipCheck("scenarios: skipped", "scenarios", "No scenarios provided")];
      }
      if (config.adapter === undefined) {
        return [skipCheck("scenarios: skipped", "scenarios", "No adapter provided for scenarios")];
      }
      return runScenarioChecks(config.adapter, config.scenarios, checkTimeoutMs);
    }

    case "custom": {
      if (config.customChecks === undefined || config.customChecks.length === 0) {
        return [];
      }
      const results: CheckResult[] = [];
      for (const check of config.customChecks) {
        results.push(
          await runCheck(
            check.name,
            "custom",
            async () => {
              await check.fn();
            },
            checkTimeoutMs,
          ),
        );
      }
      return results;
    }

    default: {
      const _exhaustive: never = category;
      throw new Error(`Unknown category: ${String(_exhaustive)}`);
    }
  }
}
