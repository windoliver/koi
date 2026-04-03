/**
 * Configuration for the tool-selector middleware.
 *
 * Supports three modes via discriminated union (kind is inferred from shape):
 * - "custom": caller-provided selectTools function (backward compatible)
 * - "profile": named tool profile (e.g., "coding", "research")
 * - "auto": profile + model-capability-aware dynamic scaling
 */

import type { InboundMessage, KoiError, Result, ToolDescriptor } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { CapabilityTier } from "./model-tier.js";
import type { ToolProfileName } from "./tool-profiles.js";
import { isToolProfileName } from "./tool-profiles.js";

// ---------------------------------------------------------------------------
// Internal validated config types (discriminated union)
// ---------------------------------------------------------------------------

export interface ValidatedCustomConfig {
  readonly kind: "custom";
  readonly selectTools: (
    query: string,
    tools: readonly ToolDescriptor[],
  ) => Promise<readonly string[]>;
  readonly alwaysInclude?: readonly string[];
  readonly maxTools?: number;
  readonly minTools?: number;
  readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
}

export interface ValidatedProfileConfig {
  readonly kind: "profile";
  readonly profile: ToolProfileName;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxTools?: number;
  readonly minTools?: number;
  readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
}

export interface ValidatedAutoConfig {
  readonly kind: "auto";
  readonly profile: ToolProfileName | "auto";
  readonly autoScale: true;
  readonly modelTierOverrides?: Readonly<Record<string, CapabilityTier>>;
  readonly tier?: CapabilityTier;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxTools?: number;
  readonly minTools?: number;
  readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
}

export type ValidatedToolSelectorConfig =
  | ValidatedCustomConfig
  | ValidatedProfileConfig
  | ValidatedAutoConfig;

// ---------------------------------------------------------------------------
// Public input type (backward compatible — no `kind` required)
// ---------------------------------------------------------------------------

/**
 * Public config — callers provide one of:
 * 1. `{ selectTools }` — custom selector (backward compatible)
 * 2. `{ profile }` — named profile
 * 3. `{ profile, autoScale: true }` — auto-scaling profile
 */
export type ToolSelectorConfig =
  | {
      readonly selectTools: (
        query: string,
        tools: readonly ToolDescriptor[],
      ) => Promise<readonly string[]>;
      readonly alwaysInclude?: readonly string[];
      readonly maxTools?: number;
      readonly minTools?: number;
      readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
    }
  | {
      readonly profile: ToolProfileName;
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
      readonly maxTools?: number;
      readonly minTools?: number;
      readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
    }
  | {
      readonly profile: ToolProfileName | "auto";
      readonly autoScale: true;
      readonly modelTierOverrides?: Readonly<Record<string, CapabilityTier>>;
      readonly tier?: CapabilityTier;
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
      readonly maxTools?: number;
      readonly minTools?: number;
      readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
    };

// ---------------------------------------------------------------------------
// Shared field validation
// ---------------------------------------------------------------------------

function validationError(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function validateSharedFields(c: Record<string, unknown>): Result<true, KoiError> {
  if (c.maxTools !== undefined) {
    if (typeof c.maxTools !== "number" || c.maxTools <= 0 || !Number.isInteger(c.maxTools)) {
      return validationError("maxTools must be a positive integer");
    }
  }

  if (c.minTools !== undefined) {
    if (typeof c.minTools !== "number" || c.minTools < 0 || !Number.isInteger(c.minTools)) {
      return validationError("minTools must be a non-negative integer");
    }
  }

  if (c.extractQuery !== undefined && typeof c.extractQuery !== "function") {
    return validationError("extractQuery must be a function");
  }

  return { ok: true, value: true };
}

function validateStringArray(value: unknown, fieldName: string): Result<true, KoiError> {
  if (value !== undefined) {
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
      return validationError(`${fieldName} must be an array of strings`);
    }
  }
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Builder helpers (avoid assigning undefined to optional properties)
// ---------------------------------------------------------------------------

/** Picks only defined optional fields — avoids exactOptionalPropertyTypes violations. */
function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function buildCustomConfig(c: Record<string, unknown>): ValidatedCustomConfig {
  return {
    kind: "custom",
    selectTools: c.selectTools as ValidatedCustomConfig["selectTools"],
    ...pickDefined({
      alwaysInclude: c.alwaysInclude as readonly string[] | undefined,
      maxTools: c.maxTools as number | undefined,
      minTools: c.minTools as number | undefined,
      extractQuery: c.extractQuery as ValidatedCustomConfig["extractQuery"],
    }),
  } as ValidatedCustomConfig;
}

function buildProfileConfig(
  c: Record<string, unknown>,
  profile: ToolProfileName,
): ValidatedProfileConfig {
  return {
    kind: "profile",
    profile,
    ...pickDefined({
      include: c.include as readonly string[] | undefined,
      exclude: c.exclude as readonly string[] | undefined,
      maxTools: c.maxTools as number | undefined,
      minTools: c.minTools as number | undefined,
      extractQuery: c.extractQuery as ValidatedProfileConfig["extractQuery"],
    }),
  } as ValidatedProfileConfig;
}

function buildAutoConfig(
  c: Record<string, unknown>,
  profile: ToolProfileName | "auto",
): ValidatedAutoConfig {
  return {
    kind: "auto",
    profile,
    autoScale: true,
    ...pickDefined({
      modelTierOverrides: c.modelTierOverrides as
        | Readonly<Record<string, CapabilityTier>>
        | undefined,
      tier: c.tier as CapabilityTier | undefined,
      include: c.include as readonly string[] | undefined,
      exclude: c.exclude as readonly string[] | undefined,
      maxTools: c.maxTools as number | undefined,
      minTools: c.minTools as number | undefined,
      extractQuery: c.extractQuery as ValidatedAutoConfig["extractQuery"],
    }),
  } as ValidatedAutoConfig;
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes tool selector config. Infers `kind` from shape:
 * - `selectTools` present -> "custom"
 * - `profile` present, no `autoScale` -> "profile"
 * - `profile` present + `autoScale: true` -> "auto"
 */
export function validateToolSelectorConfig(
  config: unknown,
): Result<ValidatedToolSelectorConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  // Mutual exclusion: profile + selectTools is invalid
  if ("selectTools" in c && "profile" in c) {
    return validationError("Config cannot have both 'selectTools' and 'profile' — choose one");
  }

  // Validate shared fields
  const sharedResult = validateSharedFields(c);
  if (!sharedResult.ok) return sharedResult;

  // Infer kind from shape
  if (typeof c.selectTools === "function") {
    // kind: "custom" (backward compatible path)
    const includeResult = validateStringArray(c.alwaysInclude, "alwaysInclude");
    if (!includeResult.ok) return includeResult;

    return { ok: true, value: buildCustomConfig(c) };
  }

  if ("selectTools" in c) {
    return validationError("Config requires a 'selectTools' function");
  }

  if ("profile" in c) {
    // Validate profile name
    const profileValue = c.profile;
    if (profileValue !== "auto" && !isToolProfileName(profileValue)) {
      return validationError(
        `Invalid profile name '${String(profileValue)}' — must be a valid profile name or 'auto'`,
      );
    }

    // Validate include/exclude
    const includeResult = validateStringArray(c.include, "include");
    if (!includeResult.ok) return includeResult;
    const excludeResult = validateStringArray(c.exclude, "exclude");
    if (!excludeResult.ok) return excludeResult;

    if (c.autoScale === true) {
      return { ok: true, value: buildAutoConfig(c, profileValue as ToolProfileName | "auto") };
    }

    // kind: "profile" — profile name must not be "auto" without autoScale
    if (profileValue === "auto") {
      return validationError("profile: 'auto' requires autoScale: true");
    }

    return { ok: true, value: buildProfileConfig(c, profileValue as ToolProfileName) };
  }

  // No selectTools and no profile — require at least one
  return validationError("Config requires a 'selectTools' function or a 'profile' name");
}
