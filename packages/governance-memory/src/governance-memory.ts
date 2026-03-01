/**
 * Factory for the in-memory GovernanceBackend.
 *
 * Wires evaluator + store + constraint checker into a composite GovernanceBackend.
 */

import type { GovernanceBackend } from "@koi/core/governance-backend";
import { createMemoryEvaluator } from "./evaluator.js";
import { createGovernanceMemoryStore } from "./store.js";
import type { GovernanceMemoryConfig } from "./types.js";

/**
 * Create an in-memory governance backend.
 *
 * The backend provides:
 * - Policy evaluation via a Cedar-inspired constraint DAG
 * - Constraint checking (delegates to DAG evaluation)
 * - Compliance recording (ring buffer)
 * - Violation storage and querying (per-agent ring buffers)
 * - Anomaly bridge integration (fail-open callback)
 * - Adaptive thresholds (tighten on violations, relax on clean evals)
 */
export function createGovernanceMemoryBackend(
  config: GovernanceMemoryConfig = {},
): GovernanceBackend {
  const evaluator = createMemoryEvaluator(config);
  const store = createGovernanceMemoryStore(
    evaluator,
    config.complianceCapacity,
    config.violationCapacity,
  );

  return {
    evaluator,
    constraints: store.constraints,
    compliance: store.compliance,
    violations: store.violations,
    dispose(): void {
      store.clear();
    },
  };
}
