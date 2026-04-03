/**
 * Bridge from KoiConfig to engine-compatible runtime options.
 */

import type {
  ForgeConfigSection,
  KoiConfig,
  LimitsConfig,
  LogLevel,
  LoopDetectionConfigSection,
  SpawnConfig,
} from "@koi/core/config";

/** Engine-compatible runtime options derived from KoiConfig. */
export interface ResolvedKoiOptions {
  readonly logLevel: LogLevel;
  readonly limits: LimitsConfig;
  readonly loopDetection: LoopDetectionConfigSection;
  readonly spawn: SpawnConfig;
  readonly forge: ForgeConfigSection;
  readonly telemetryEnabled: boolean;
  readonly telemetryEndpoint: string | undefined;
  readonly telemetrySampleRate: number | undefined;
  readonly modelRouterStrategy: string;
  readonly modelRouterTargets: KoiConfig["modelRouter"]["targets"];
  readonly features: Readonly<Record<string, boolean | undefined>>;
}

/**
 * Maps a validated `KoiConfig` into flat, engine-compatible options.
 *
 * This is a pure function — no side effects, no I/O.
 */
export function resolveKoiOptions(config: KoiConfig): ResolvedKoiOptions {
  return {
    logLevel: config.logLevel,
    limits: config.limits,
    loopDetection: config.loopDetection,
    spawn: config.spawn,
    forge: config.forge,
    telemetryEnabled: config.telemetry.enabled,
    telemetryEndpoint: config.telemetry.endpoint,
    telemetrySampleRate: config.telemetry.sampleRate,
    modelRouterStrategy: config.modelRouter.strategy,
    modelRouterTargets: config.modelRouter.targets,
    features: config.features,
  };
}
