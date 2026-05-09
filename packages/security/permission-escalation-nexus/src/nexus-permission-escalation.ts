import type { PermissionDecision, PermissionEscalation, PermissionRequest } from "@koi/core";
import {
  validateNexusPermissionEscalationConfig,
  type NexusPermissionEscalationConfig,
} from "./config.js";

export function createNexusPermissionEscalation(
  config: NexusPermissionEscalationConfig,
): PermissionEscalation {
  const validated = validateNexusPermissionEscalationConfig(config);
  if (!validated.ok) {
    throw new Error(validated.error.message);
  }

  return {
    async request(_req: PermissionRequest): Promise<PermissionDecision> {
      throw new Error("createNexusPermissionEscalation is not implemented yet");
    },
  };
}
