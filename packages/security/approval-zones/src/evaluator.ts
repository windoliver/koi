import type { PermissionQuery } from "@koi/core";
import type { RiskAssessment, RiskScorer } from "./risk-types.js";
import { compareRisk } from "./risk-types.js";
import { matchesZone } from "./zone-match.js";
import type { ApprovalZone, ZoneVerdict } from "./zone-types.js";

export interface ZoneEvaluatorConfig {
  readonly zones: readonly ApprovalZone[];
  readonly scorer: RiskScorer;
}

export interface ZoneEvaluator {
  evaluate(query: PermissionQuery): Promise<ZoneVerdict>;
}

const DEFAULT_MAX_RISK = "low";

function findMatchingZone(
  query: PermissionQuery,
  zones: readonly ApprovalZone[],
): ApprovalZone | undefined | "error" {
  try {
    for (const zone of zones) {
      if (matchesZone(query, zone)) return zone;
    }
    return undefined;
  } catch {
    return "error";
  }
}

async function scoreOrError(
  scorer: RiskScorer,
  query: PermissionQuery,
): Promise<RiskAssessment | "error"> {
  try {
    return await Promise.resolve(
      scorer.score({
        toolId: query.action,
        args: query.context ?? {},
        resource: query.resource,
        bashCommand:
          query.action === "bash" && typeof query.context?.command === "string"
            ? (query.context.command as string)
            : undefined,
      }),
    );
  } catch {
    return "error";
  }
}

function decide(matched: ApprovalZone, assessment: RiskAssessment, action: string): ZoneVerdict {
  const meta = {
    zone: matched.name,
    risk: assessment.tier,
    riskReasons: assessment.reasons,
  } as const;
  const maxRisk = matched.maxRisk ?? DEFAULT_MAX_RISK;
  if (compareRisk(assessment.tier, maxRisk) > 0) {
    return { kind: "ask", reason: "risk-exceeded", ...meta };
  }
  if (matched.action === "ask") return { kind: "ask", reason: "no-match", ...meta };
  if (matched.action === "auto") return { kind: "auto", ...meta };
  // sandbox-then-auto
  if (action !== "bash") return { kind: "ask", reason: "non-bash-tool", ...meta };
  if (matched.sandboxBackendId === undefined) {
    return { kind: "ask", reason: "missing-backend", ...meta };
  }
  return { kind: "sandbox", backendId: matched.sandboxBackendId, ...meta };
}

export function createZoneEvaluator(config: ZoneEvaluatorConfig): ZoneEvaluator {
  return {
    async evaluate(query: PermissionQuery): Promise<ZoneVerdict> {
      const matched = findMatchingZone(query, config.zones);
      if (matched === "error") return { kind: "ask", reason: "matcher-error" };
      if (matched === undefined) return { kind: "ask", reason: "no-match" };
      const assessment = await scoreOrError(config.scorer, query);
      if (assessment === "error") return { kind: "ask", reason: "scorer-error" };
      return decide(matched, assessment, query.action);
    },
  };
}
