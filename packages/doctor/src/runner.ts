/**
 * Doctor runner — parallel rule execution with timeout containment.
 *
 * Follows the @koi/self-test/check-runner.ts timeout pattern.
 */

import { meetsSeverityThreshold, resolveConfig, validateDoctorConfig } from "./config.js";
import { createDoctorContext } from "./context.js";
import { computeOwaspSummary } from "./owasp.js";
import { getBuiltinRules } from "./rules/index.js";
import type {
  AdvisoryCallback,
  Doctor,
  DoctorConfig,
  DoctorContext,
  DoctorFinding,
  DoctorReport,
  DoctorRule,
  DoctorRuleError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RuleResult {
  readonly findings: readonly DoctorFinding[];
  readonly error?: DoctorRuleError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRuleName(reason: unknown): string {
  if (reason !== null && reason !== undefined && typeof reason === "object" && "rule" in reason) {
    return String((reason as { readonly rule: unknown }).rule);
  }
  return "unknown";
}

function extractTimedOut(reason: unknown): boolean {
  if (
    reason !== null &&
    reason !== undefined &&
    typeof reason === "object" &&
    "timedOut" in reason
  ) {
    return (reason as { readonly timedOut: unknown }).timedOut === true;
  }
  return false;
}

const EMPTY_SETTLED: readonly PromiseSettledResult<RuleResult>[] = [];

function applySeverityOverride(
  finding: DoctorFinding,
  overrides: Readonly<Record<string, import("@koi/validation").Severity>>,
): DoctorFinding {
  const override = overrides[finding.rule];
  if (override === undefined || override === finding.severity) return finding;
  return { ...finding, severity: override };
}

function collectResults(
  settled: readonly PromiseSettledResult<RuleResult>[],
  severityThreshold: import("@koi/validation").Severity,
  severityOverrides: Readonly<Record<string, import("@koi/validation").Severity>>,
): {
  readonly findings: readonly DoctorFinding[];
  readonly ruleErrors: readonly DoctorRuleError[];
} {
  // Local accumulation arrays — `let` justified: building from iteration results
  let findings: readonly DoctorFinding[] = [];
  let ruleErrors: readonly DoctorRuleError[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      const { findings: ruleFindings, error } = result.value;
      if (error !== undefined) {
        ruleErrors = [...ruleErrors, error];
      }
      const overridden = ruleFindings.map((f) => applySeverityOverride(f, severityOverrides));
      const filtered = overridden.filter((f) =>
        meetsSeverityThreshold(f.severity, severityThreshold),
      );
      findings = [...findings, ...filtered];
    } else {
      ruleErrors = [
        ...ruleErrors,
        {
          rule: extractRuleName(result.reason),
          message: "Rule execution failed unexpectedly",
          durationMs: 0,
          timedOut: extractTimedOut(result.reason),
        },
      ];
    }
  }

  return { findings, ruleErrors };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDoctor(config: DoctorConfig): Doctor {
  validateDoctorConfig(config);
  const resolved = resolveConfig(config);
  const enabledSet = new Set(resolved.enabledCategories);

  const builtinRules = getBuiltinRules();
  const allRules: readonly DoctorRule[] = [
    ...builtinRules.filter((r) => enabledSet.has(r.category)),
    ...resolved.customRules.filter((r) => enabledSet.has(r.category)),
  ];

  const ctx = createDoctorContext(resolved.manifest, {
    dependencies: resolved.dependencies,
    ...(resolved.envKeys !== undefined ? { envKeys: resolved.envKeys } : {}),
  });

  return {
    async run(): Promise<DoctorReport> {
      const start = Date.now();

      const globalSignal = AbortSignal.timeout(resolved.timeoutMs);
      const globalAbort = new Promise<never>((_, reject) => {
        globalSignal.addEventListener("abort", () => reject(globalSignal.reason), { once: true });
      });

      const settled = await Promise.race([
        Promise.allSettled(allRules.map((rule) => executeRule(rule, ctx, resolved.ruleTimeoutMs))),
        globalAbort.then(() => EMPTY_SETTLED),
      ]).catch((): readonly PromiseSettledResult<RuleResult>[] => {
        // Global timeout — return empty, all rules treated as timed out
        return allRules.map((rule) => ({
          status: "rejected" as const,
          reason: { rule: rule.name, timedOut: true },
        }));
      });

      const advisoryFindings = await runAdvisoryCallback(
        resolved.advisoryCallback,
        ctx.dependencies(),
      );

      const { findings: ruleFindings, ruleErrors } = collectResults(
        settled,
        resolved.severityThreshold,
        resolved.severityOverrides,
      );
      const findings = [...ruleFindings, ...advisoryFindings];

      const truncationWarning = findings.length > resolved.maxFindings;
      const truncatedFindings = truncationWarning
        ? findings.slice(0, resolved.maxFindings)
        : findings;

      const owaspSummary = computeOwaspSummary(truncatedFindings);
      const healthy = !truncatedFindings.some(
        (f) => f.severity === "CRITICAL" || f.severity === "HIGH",
      );

      return {
        findings: truncatedFindings,
        ruleErrors,
        rulesApplied: allRules.length,
        durationMs: Date.now() - start,
        owaspSummary,
        healthy,
        truncationWarning,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-rule execution with timeout
// ---------------------------------------------------------------------------

async function runAdvisoryCallback(
  callback: AdvisoryCallback | undefined,
  deps: readonly import("./types.js").DependencyEntry[],
): Promise<readonly DoctorFinding[]> {
  if (callback === undefined) return [];
  try {
    return await Promise.resolve(callback(deps));
  } catch (_e: unknown) {
    // Advisory callback failure is non-fatal — findings come from rules instead
    return [];
  }
}

async function executeRule(
  rule: DoctorRule,
  ctx: DoctorContext,
  timeoutMs: number,
): Promise<RuleResult> {
  const start = Date.now();
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const timeoutRejection = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    const findings = await Promise.race([Promise.resolve(rule.check(ctx)), timeoutRejection]);

    return { findings };
  } catch (e: unknown) {
    const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
    return {
      findings: [],
      error: {
        rule: rule.name,
        message: isTimeout
          ? `Rule "${rule.name}" timed out after ${String(timeoutMs)}ms`
          : e instanceof Error
            ? e.message
            : String(e),
        durationMs: Date.now() - start,
        timedOut: isTimeout,
      },
    };
  }
}
