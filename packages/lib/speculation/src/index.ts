/**
 * @koi/speculation — speculative fork execution coordinator.
 *
 * Owns best-effort speculative pre-execution lifecycle only. Hosts inject
 * fork execution, overlay storage, and presentation so this L2 package stays
 * independent of engine, workspace, and UI packages.
 */

export { createSpeculationController } from "./controller.js";
export type {
  PresentSpeculationResult,
  SpeculationAcceptResponse,
  SpeculationAcceptResult,
  SpeculationController,
  SpeculationControllerConfig,
  SpeculationFallbackReason,
  SpeculationForkAgent,
  SpeculationForkRequest,
  SpeculationForkResult,
  SpeculationOverlay,
  SpeculationOverlayManager,
  SpeculationPresentedResult,
  SpeculationRejectResponse,
  SpeculationSnapshot,
  SpeculationStartResult,
  SpeculationStatus,
  StartSpeculationRequest,
} from "./types.js";
