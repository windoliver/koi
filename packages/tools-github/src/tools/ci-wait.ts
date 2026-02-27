/**
 * Tool factory for `github_ci_wait` — poll CI checks until completion or timeout.
 */

import type { JsonObject, Tool, ToolExecuteOptions, TrustTier } from "@koi/core";
import {
  CI_WAIT_FIELDS,
  DEFAULT_CI_POLL_INTERVAL_MS,
  DEFAULT_CI_TIMEOUT_MS,
  MAX_CI_TIMEOUT_MS,
  MIN_CI_POLL_INTERVAL_MS,
} from "../constants.js";
import type { GhExecutor } from "../gh-executor.js";
import { parseOptionalBoolean, parseOptionalTimeout, parsePrNumber } from "../parse-args.js";
import { isRecord, mapErrorResult, parseGhJson } from "../parse-gh-error.js";

/** Statuses that indicate a check has finished running. */
const COMPLETED_STATUSES = new Set([
  "COMPLETED",
  "SUCCESS",
  "FAILURE",
  "CANCELLED",
  "ERROR",
  "TIMED_OUT",
]);

/** Conclusions that indicate a check failed. */
const FAILURE_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR"]);

export function createGithubCiWaitTool(
  executor: GhExecutor,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_ci_wait`,
      description:
        "Wait for CI checks on a PR to complete by polling. " +
        "Returns the final status of all checks. Use fail_fast=true to stop on first failure.",
      inputSchema: {
        type: "object",
        properties: {
          pr_number: { type: "number", description: "Pull request number" },
          timeout_ms: {
            type: "number",
            description: `Max wait time in ms (default: ${DEFAULT_CI_TIMEOUT_MS}, max: ${MAX_CI_TIMEOUT_MS})`,
          },
          poll_interval_ms: {
            type: "number",
            description: `Polling interval in ms (default: ${DEFAULT_CI_POLL_INTERVAL_MS}, min: ${MIN_CI_POLL_INTERVAL_MS})`,
          },
          fail_fast: {
            type: "boolean",
            description: "Stop on first failing check (default: false)",
          },
        },
        required: ["pr_number"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      const prResult = parsePrNumber(args, "pr_number");
      if (!prResult.ok) return prResult.err;

      const timeoutResult = parseOptionalTimeout(args, "timeout_ms", 1, MAX_CI_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      const pollResult = parseOptionalTimeout(args, "poll_interval_ms", 1, MAX_CI_TIMEOUT_MS);
      if (!pollResult.ok) return pollResult.err;

      const failFastResult = parseOptionalBoolean(args, "fail_fast");
      if (!failFastResult.ok) return failFastResult.err;

      const timeoutMs = timeoutResult.value ?? DEFAULT_CI_TIMEOUT_MS;
      const pollIntervalMs = pollResult.value ?? DEFAULT_CI_POLL_INTERVAL_MS;
      const failFast = failFastResult.value ?? false;
      const signal = options?.signal;

      const startTime = Date.now();
      const deadline = startTime + timeoutMs;

      while (true) {
        // Check abort signal at top of each iteration
        if (signal?.aborted) {
          return {
            status: "timeout",
            checks: [],
            elapsed_ms: Date.now() - startTime,
            message: "Operation aborted",
          };
        }

        const outcome = await pollChecks(executor, prResult.value);
        if (!outcome.ok) return outcome.error;

        const { checks, allComplete, hasFailure } = outcome.value;

        // Check for fail_fast
        if (failFast && hasFailure) {
          return {
            status: "failure",
            checks,
            elapsed_ms: Date.now() - startTime,
          };
        }

        // All checks complete
        if (allComplete) {
          return {
            status: hasFailure ? "failure" : "success",
            checks,
            elapsed_ms: Date.now() - startTime,
          };
        }

        // Check timeout
        if (Date.now() + pollIntervalMs > deadline) {
          return {
            status: "timeout",
            checks,
            elapsed_ms: Date.now() - startTime,
          };
        }

        // Wait before next poll
        await sleep(pollIntervalMs);
      }
    },
  };
}

interface PollResult {
  readonly checks: readonly CheckInfo[];
  readonly allComplete: boolean;
  readonly hasFailure: boolean;
}

interface CheckInfo {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** Discriminated union for poll outcome — avoids `as Type` assertions. */
type PollOutcome =
  | { readonly ok: true; readonly value: PollResult }
  | { readonly ok: false; readonly error: { readonly error: string; readonly code: string } };

async function pollChecks(executor: GhExecutor, prNumber: number): Promise<PollOutcome> {
  const result = await executor.execute(["pr", "view", String(prNumber), "--json", CI_WAIT_FIELDS]);

  if (!result.ok) {
    return { ok: false, error: mapErrorResult(result.error) };
  }

  const parsed = parseGhJson(result.value);
  if (!parsed.ok) {
    return { ok: false, error: mapErrorResult(parsed.error) };
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, error: { error: "Unexpected response format from gh", code: "EXTERNAL" } };
  }

  const data = parsed.value;
  const rawChecks = data.statusCheckRollup;

  // No checks configured — immediate success
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    return { ok: true, value: { checks: [], allComplete: true, hasFailure: false } };
  }

  const checks: readonly CheckInfo[] = rawChecks.map((c: unknown) => {
    if (!isRecord(c)) {
      return { name: "unknown", status: "UNKNOWN", conclusion: null };
    }
    return {
      name: String(c.name ?? c.context ?? "unknown"),
      status: String(c.status ?? "UNKNOWN"),
      conclusion: c.conclusion != null ? String(c.conclusion) : null,
    };
  });

  const allComplete = checks.every(
    (c) => COMPLETED_STATUSES.has(c.status) || c.conclusion !== null,
  );
  const hasFailure = checks.some(
    (c) => c.conclusion !== null && FAILURE_CONCLUSIONS.has(c.conclusion),
  );

  return { ok: true, value: { checks, allComplete, hasFailure } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
