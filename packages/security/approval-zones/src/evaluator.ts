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

export function createZoneEvaluator(config: ZoneEvaluatorConfig): ZoneEvaluator {
  return {
    async evaluate(query: PermissionQuery): Promise<ZoneVerdict> {
      let matched: ApprovalZone | undefined;
      try {
        for (const zone of config.zones) {
          if (matchesZone(query, zone)) {
            matched = zone;
            break;
          }
        }
      } catch {
        return { kind: "ask", reason: "matcher-error" };
      }
      if (matched === undefined) return { kind: "ask", reason: "no-match" };

      let assessment: RiskAssessment;
      try {
        assessment = await Promise.resolve(
          config.scorer.score({
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
        return { kind: "ask", reason: "scorer-error" };
      }

      const maxRisk = matched.maxRisk ?? DEFAULT_MAX_RISK;
      if (compareRisk(assessment.tier, maxRisk) > 0) {
        return {
          kind: "ask",
          reason: "risk-exceeded",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }

      if (matched.action === "ask") {
        return {
          kind: "ask",
          reason: "no-match",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }

      if (matched.action === "auto") {
        return {
          kind: "auto",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }

      // sandbox-then-auto
      if (query.action !== "bash") {
        return {
          kind: "ask",
          reason: "non-bash-tool",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }
      if (matched.sandboxBackendId === undefined) {
        return {
          kind: "ask",
          reason: "missing-backend",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }
      return {
        kind: "sandbox",
        zone: matched.name,
        risk: assessment.tier,
        backendId: matched.sandboxBackendId,
        riskReasons: assessment.reasons,
      };
    },
  };
}
