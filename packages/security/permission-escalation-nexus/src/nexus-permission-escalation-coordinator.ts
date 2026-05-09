import type { PermissionDecision, PermissionRequest } from "@koi/core";
import {
  validateNexusPermissionEscalationCoordinatorConfig,
  type NexusPermissionEscalationCoordinatorConfig,
} from "./config.js";

export function createNexusPermissionEscalationCoordinator(
  config: NexusPermissionEscalationCoordinatorConfig,
) {
  const validated = validateNexusPermissionEscalationCoordinatorConfig(config);
  if (!validated.ok) {
    throw new Error(validated.error.message);
  }

  return {
    async pollOnce(
      _resolve: (request: PermissionRequest) => Promise<PermissionDecision>,
    ): Promise<number> {
      throw new Error("createNexusPermissionEscalationCoordinator is not implemented yet");
    },
    dispose(): void {},
  };
}
