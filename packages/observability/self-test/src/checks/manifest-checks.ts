/**
 * Manifest structural validation checks.
 *
 * Verifies that the AgentManifest has valid name, version, model config,
 * and that tool/middleware config entries have non-empty names.
 */

import type { AgentManifest } from "@koi/core";
import { runCheck } from "../check-runner.js";
import type { CheckResult } from "../types.js";

export async function runManifestChecks(
  manifest: AgentManifest,
  checkTimeoutMs: number,
): Promise<readonly CheckResult[]> {
  // Local mutable array for sequential accumulation
  const results: CheckResult[] = [];

  results.push(
    await runCheck(
      "manifest: name is non-empty string",
      "manifest",
      () => {
        if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
          throw new Error("manifest.name must be a non-empty string");
        }
      },
      checkTimeoutMs,
    ),
  );

  results.push(
    await runCheck(
      "manifest: version is non-empty string",
      "manifest",
      () => {
        if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
          throw new Error("manifest.version must be a non-empty string");
        }
      },
      checkTimeoutMs,
    ),
  );

  results.push(
    await runCheck(
      "manifest: model config is present and valid",
      "manifest",
      () => {
        if (manifest.model === undefined || manifest.model === null) {
          throw new Error("manifest.model must be defined");
        }
        if (typeof manifest.model.name !== "string" || manifest.model.name.trim().length === 0) {
          throw new Error("manifest.model.name must be a non-empty string");
        }
      },
      checkTimeoutMs,
    ),
  );

  results.push(
    await runCheck(
      "manifest: tool configs have valid names",
      "manifest",
      () => {
        if (manifest.tools === undefined) return;
        for (const tool of manifest.tools) {
          if (typeof tool.name !== "string" || tool.name.trim().length === 0) {
            throw new Error(
              `manifest.tools contains entry with invalid name: ${JSON.stringify(tool.name)}`,
            );
          }
        }
      },
      checkTimeoutMs,
    ),
  );

  results.push(
    await runCheck(
      "manifest: middleware configs have valid names",
      "manifest",
      () => {
        if (manifest.middleware === undefined) return;
        for (const mw of manifest.middleware) {
          if (typeof mw.name !== "string" || mw.name.trim().length === 0) {
            throw new Error(
              `manifest.middleware contains entry with invalid name: ${JSON.stringify(mw.name)}`,
            );
          }
        }
      },
      checkTimeoutMs,
    ),
  );

  return results;
}
