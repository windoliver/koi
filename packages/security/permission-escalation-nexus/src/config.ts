import type { AgentId, KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusPermissionEscalationConfig {
  readonly transport: NexusTransport;
  readonly agentId: AgentId;
  readonly coordinatorAgentId: AgentId;
  readonly requestMethodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
}

export interface NexusPermissionEscalationCoordinatorConfig {
  readonly transport: NexusTransport;
  readonly coordinatorAgentId: AgentId;
  readonly requestMethodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
}

interface RawWorkerConfig {
  readonly transport?: unknown;
  readonly agentId?: unknown;
  readonly coordinatorAgentId?: unknown;
  readonly requestMethodPrefix?: unknown;
  readonly pollIntervalMs?: unknown;
  readonly clock?: unknown;
}

interface RawCoordinatorConfig {
  readonly transport?: unknown;
  readonly coordinatorAgentId?: unknown;
  readonly requestMethodPrefix?: unknown;
  readonly pollIntervalMs?: unknown;
  readonly clock?: unknown;
}

function validationError(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: false },
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateTransport(
  transport: unknown,
): transport is Pick<NexusTransport, "call" | "close"> & Partial<NexusTransport> {
  return (
    typeof transport === "object" &&
    transport !== null &&
    typeof (transport as { call?: unknown }).call === "function" &&
    typeof (transport as { close?: unknown }).close === "function"
  );
}

function validateOptionalPollIntervalMs(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function validateOptionalClock(value: unknown): value is (() => number) | undefined {
  return value === undefined || typeof value === "function";
}

function validateWorkerConfigShape(
  raw: unknown,
): Result<NexusPermissionEscalationConfig, KoiError> {
  if (typeof raw !== "object" || raw === null) {
    return validationError("config must be an object");
  }

  const obj = raw as RawWorkerConfig;

  if (!validateTransport(obj.transport)) {
    return validationError("config.transport must be provided");
  }
  if (!isNonEmptyString(obj.agentId)) {
    return validationError("config.agentId must be provided");
  }
  if (!isNonEmptyString(obj.coordinatorAgentId)) {
    return validationError("config.coordinatorAgentId must be provided");
  }
  if (
    obj.requestMethodPrefix !== undefined &&
    !isNonEmptyString(obj.requestMethodPrefix)
  ) {
    return validationError("config.requestMethodPrefix must be a non-empty string");
  }
  if (!validateOptionalPollIntervalMs(obj.pollIntervalMs)) {
    return validationError("config.pollIntervalMs must be a non-negative number");
  }
  if (!validateOptionalClock(obj.clock)) {
    return validationError("config.clock must be a function");
  }

  return { ok: true, value: raw as NexusPermissionEscalationConfig };
}

export function validateNexusPermissionEscalationCoordinatorConfig(
  raw: unknown,
): Result<NexusPermissionEscalationCoordinatorConfig, KoiError> {
  if (typeof raw !== "object" || raw === null) {
    return validationError("config must be an object");
  }

  const obj = raw as RawCoordinatorConfig;

  if (!validateTransport(obj.transport)) {
    return validationError("config.transport must be provided");
  }
  if (!isNonEmptyString(obj.coordinatorAgentId)) {
    return validationError("config.coordinatorAgentId must be provided");
  }
  if (
    obj.requestMethodPrefix !== undefined &&
    !isNonEmptyString(obj.requestMethodPrefix)
  ) {
    return validationError("config.requestMethodPrefix must be a non-empty string");
  }
  if (!validateOptionalPollIntervalMs(obj.pollIntervalMs)) {
    return validationError("config.pollIntervalMs must be a non-negative number");
  }
  if (!validateOptionalClock(obj.clock)) {
    return validationError("config.clock must be a function");
  }

  return { ok: true, value: raw as NexusPermissionEscalationCoordinatorConfig };
}

export function validateNexusPermissionEscalationConfig(
  raw: unknown,
): Result<NexusPermissionEscalationConfig, KoiError> {
  return validateWorkerConfigShape(raw);
}
