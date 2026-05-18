import type { KoiError, Result, SpawnRequest, SpawnResult, WorkspaceId } from "@koi/core";

export interface SpeculationOverlay {
  readonly id: WorkspaceId;
  readonly path: string;
  readonly baseCommit?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface SpeculationAcceptResult {
  readonly changedPaths: readonly string[];
}

export interface SpeculationOverlayManager {
  readonly create: () => Promise<Result<SpeculationOverlay, KoiError>>;
  readonly accept: (id: WorkspaceId) => Promise<Result<SpeculationAcceptResult, KoiError>>;
  readonly reject: (id: WorkspaceId) => Promise<Result<void, KoiError>>;
}

export interface SpeculationForkRequest {
  readonly description: string;
  readonly agentName: string;
  readonly overlay: SpeculationOverlay;
  readonly signal: AbortSignal;
  readonly spawnRequest?: Omit<SpawnRequest, "signal"> | undefined;
}

export type SpeculationForkResult = SpawnResult;

export type SpeculationForkAgent = (
  request: SpeculationForkRequest,
) => Promise<SpeculationForkResult>;

export interface SpeculationPresentedResult {
  readonly id: WorkspaceId;
  readonly overlay: SpeculationOverlay;
  readonly output: string;
}

export type PresentSpeculationResult = (result: SpeculationPresentedResult) => void | Promise<void>;

export type SpeculationFallbackReason =
  | "overlay_create_failed"
  | "fork_failed"
  | "present_failed"
  | "accept_failed"
  | "reject_failed"
  | "resource_limit"
  | "cancelled"
  | "timeout";

export type SpeculationStartResult =
  | {
      readonly kind: "started";
      readonly id: WorkspaceId;
      readonly overlay: SpeculationOverlay;
    }
  | {
      readonly kind: "fallback";
      readonly reason: SpeculationFallbackReason;
      readonly error?: KoiError | undefined;
    };

export type SpeculationStatus =
  | "running"
  | "presented"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "fallback";

export interface SpeculationSnapshot {
  readonly id: WorkspaceId;
  readonly overlay: SpeculationOverlay;
  readonly status: SpeculationStatus;
  readonly output?: string | undefined;
  readonly fallbackReason?: SpeculationFallbackReason | undefined;
}

export type SpeculationAcceptResponse =
  | {
      readonly kind: "accepted";
      readonly id: WorkspaceId;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly kind: "fallback";
      readonly id: WorkspaceId;
      readonly reason: SpeculationFallbackReason;
      readonly error?: KoiError | undefined;
    };

export type SpeculationRejectResponse =
  | {
      readonly kind: "rejected";
      readonly id: WorkspaceId;
    }
  | {
      readonly kind: "fallback";
      readonly id: WorkspaceId;
      readonly reason: SpeculationFallbackReason;
      readonly error?: KoiError | undefined;
    };

export interface SpeculationControllerConfig {
  readonly overlayManager: SpeculationOverlayManager;
  readonly forkAgent: SpeculationForkAgent;
  readonly presentResult?: PresentSpeculationResult | undefined;
  readonly maxConcurrent?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface StartSpeculationRequest {
  readonly description: string;
  readonly agentName: string;
  readonly spawnRequest?: Omit<SpawnRequest, "signal"> | undefined;
}

export interface SpeculationController {
  readonly start: (request: StartSpeculationRequest) => Promise<SpeculationStartResult>;
  readonly accept: (id: WorkspaceId) => Promise<SpeculationAcceptResponse>;
  readonly reject: (id: WorkspaceId) => Promise<SpeculationRejectResponse>;
  readonly cancelAll: (reason?: "new_user_input" | "shutdown") => Promise<readonly WorkspaceId[]>;
  readonly snapshot: (id: WorkspaceId) => SpeculationSnapshot | undefined;
  readonly list: () => readonly SpeculationSnapshot[];
  readonly waitForIdle: () => Promise<void>;
}
