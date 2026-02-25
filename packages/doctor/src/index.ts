/**
 * @koi/doctor — Security scanner + deployment audits (Layer 2)
 *
 * Pre-deployment static analysis of AgentManifest configurations,
 * aligned with the OWASP Agentic Top 10.
 */

export { resolveConfig, validateDoctorConfig } from "./config.js";
export type { CreateDoctorContextOptions } from "./context.js";
export { createDoctorContext } from "./context.js";
export { computeOwaspSummary } from "./owasp.js";
export { getBuiltinRules } from "./rules/index.js";
export { createDoctor } from "./runner.js";
export { mapDoctorReportToSarif } from "./sarif.js";
export type {
  AdvisoryCallback,
  DependencyEntry,
  Doctor,
  DoctorCategory,
  DoctorConfig,
  DoctorContext,
  DoctorFinding,
  DoctorReport,
  DoctorRule,
  DoctorRuleError,
  OwaspAgenticId,
  OwaspCoverage,
  ResolvedDoctorConfig,
  SarifLog,
  SarifResult,
  SarifRun,
} from "./types.js";
