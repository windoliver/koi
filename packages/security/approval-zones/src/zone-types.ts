import type { RiskTier } from "./risk-types.js";

export type ZoneAction = "auto" | "ask" | "sandbox-then-auto";

export interface ZoneMatch {
  /** Glob patterns matched against `PermissionQuery.action` (the toolId). */
  readonly tools?: readonly string[];
  /** Glob patterns matched against `PermissionQuery.resource`. */
  readonly paths?: readonly string[];
  /** Per-arg-key glob predicates against `PermissionQuery.context`. */
  readonly args?: Readonly<Record<string, string>>;
}

export interface ApprovalZone {
  readonly name: string;
  readonly match: ZoneMatch;
  readonly action: ZoneAction;
  /** Default `"low"` if omitted. Action only fires when score ≤ this. */
  readonly maxRisk?: RiskTier;
  /** Required when `action === "sandbox-then-auto"`. */
  readonly sandboxBackendId?: string;
}

export type ZoneVerdict =
  | {
      readonly kind: "auto";
      readonly zone: string;
      readonly risk: RiskTier;
      readonly riskReasons?: readonly string[];
    }
  | {
      readonly kind: "sandbox";
      readonly zone: string;
      readonly risk: RiskTier;
      readonly backendId: string;
      readonly riskReasons?: readonly string[];
    }
  | {
      readonly kind: "ask";
      readonly reason:
        | "no-match"
        | "risk-exceeded"
        | "missing-backend"
        | "non-bash-tool"
        | "matcher-error"
        | "scorer-error";
      readonly zone?: string;
      readonly risk?: RiskTier;
      readonly riskReasons?: readonly string[];
    };
