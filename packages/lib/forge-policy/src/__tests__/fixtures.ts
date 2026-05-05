import type { BrickKind, ForgeScope } from "@koi/core";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import type { ForgeCandidate } from "@koi/forge-types";
import type { ForgePolicyConfig } from "../config.js";

export function makeCandidate(overrides: Partial<ForgeCandidate> = {}): ForgeCandidate {
  const base: ForgeCandidate = {
    id: "cand-1",
    kind: "tool",
    name: "user.add_two_numbers",
    description: "add two numbers",
    priority: 0.5,
    proposedScope: "agent",
    createdAt: 1_700_000_000_000,
  };
  return { ...base, ...overrides };
}

export function makeConfig(overrides: Partial<ForgePolicyConfig> = {}): ForgePolicyConfig {
  const allowedKinds: readonly BrickKind[] = ["tool", "skill"];
  const maxScope: ForgeScope = "zone";
  const requireApprovalAtOrAbove: ForgeScope = "global";
  const base: ForgePolicyConfig = {
    allowedKinds,
    maxScope,
    budget: DEFAULT_FORGE_BUDGET,
    requireApprovalAtOrAbove,
  };
  return { ...base, ...overrides };
}
