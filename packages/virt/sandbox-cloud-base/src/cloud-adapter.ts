/**
 * Generic cloud adapter factory — shared scaffolding for cloud sandbox adapters.
 *
 * Handles: validate config → check profile → create SDK → createCloudInstance → nexus mount.
 * Available for new adapters and future migrations. Existing adapters are NOT migrated in this PR.
 */

import type { KoiError, Result, SandboxAdapter, SandboxInstance, SandboxProfile } from "@koi/core";
import { createCloudInstance } from "./cloud-instance.js";
import { mountNexusFuse } from "./nexus-mount.js";
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "./validate-profile.js";

/** Specification for a cloud adapter backend. */
export interface CloudAdapterSpec<TConfig, TValidated, TSdk> {
  /** Adapter name (e.g., "e2b", "daytona"). */
  readonly name: string;
  /** Validate raw config → resolved config. */
  readonly validate: (config: TConfig) => Result<TValidated, KoiError>;
  /** Create the cloud SDK sandbox from resolved config and profile. */
  readonly createSdk: (config: TValidated, profile: SandboxProfile) => Promise<TSdk>;
  /** Classify provider-specific errors. */
  readonly classifyError: (
    error: unknown,
    durationMs: number,
  ) => {
    readonly code: "CRASH" | "TIMEOUT" | "OOM";
    readonly message: string;
    readonly durationMs: number;
  };
  /** Destroy/teardown the SDK sandbox. */
  readonly destroySdk: (sdk: TSdk) => Promise<void>;
  /** Detach (pause) the SDK sandbox. Optional — enables persistence. */
  readonly detachSdk?: ((sdk: TSdk) => Promise<void>) | undefined;
  /**
   * Find an existing sandbox by scope or create a new one.
   * Optional — enables cross-session persistence.
   */
  readonly findOrCreate?:
    | ((config: TValidated, scope: string, profile: SandboxProfile) => Promise<TSdk>)
    | undefined;
  /** Map SDK to CloudSdkSandbox shape. Defaults to identity cast. */
  readonly mapSdk?:
    | ((sdk: TSdk) => {
        readonly commands: {
          readonly run: (
            cmd: string,
            opts?: {
              readonly cwd?: string;
              readonly envs?: Record<string, string>;
              readonly timeoutMs?: number;
              readonly onStdout?: (data: string) => void;
              readonly onStderr?: (data: string) => void;
            },
          ) => Promise<{
            readonly exitCode: number;
            readonly stdout: string;
            readonly stderr: string;
          }>;
          readonly spawn?: (
            cmd: string,
            opts?: {
              readonly cwd?: string;
              readonly envs?: Record<string, string>;
              readonly onStdout?: (data: string) => void;
              readonly onStderr?: (data: string) => void;
            },
          ) => Promise<{
            readonly pid: number;
            readonly sendStdin: (data: string) => void | Promise<void>;
            readonly closeStdin: () => void;
            readonly exited: Promise<number>;
            readonly kill: (signal?: number) => void;
          }>;
        };
        readonly files: {
          readonly read: (path: string) => Promise<string>;
          readonly write: (path: string, content: string) => Promise<void>;
        };
      })
    | undefined;
}

/**
 * Create a cloud SandboxAdapter from a specification.
 *
 * Validates config, then returns an adapter that creates cloud sandbox instances
 * with optional nexus mount and persistence support.
 */
export function createCloudAdapter<TConfig, TValidated, TSdk>(
  config: TConfig,
  spec: CloudAdapterSpec<TConfig, TValidated, TSdk>,
): Result<SandboxAdapter, KoiError> {
  const validated = spec.validate(config);
  if (!validated.ok) return validated;

  const resolvedConfig = validated.value;

  const detachSdkFn = spec.detachSdk;

  async function createInstance(sdk: TSdk, profile: SandboxProfile): Promise<SandboxInstance> {
    const mappedSdk = spec.mapSdk !== undefined ? spec.mapSdk(sdk) : (sdk as never);
    const instance = createCloudInstance({
      sdk: mappedSdk,
      classifyError: spec.classifyError,
      destroy: () => spec.destroySdk(sdk),
      name: spec.name,
      ...(detachSdkFn !== undefined ? { detach: () => detachSdkFn(sdk) } : {}),
    });
    if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) {
      await mountNexusFuse(instance, profile.nexusMounts);
    }
    return instance;
  }

  return {
    ok: true,
    value: {
      name: spec.name,
      create: async (profile: SandboxProfile) => {
        const unsupported = detectUnsupportedProfileFields(profile);
        if (unsupported !== undefined) {
          throw new Error(formatUnsupportedProfileError(spec.name, unsupported));
        }
        const sdk = await spec.createSdk(resolvedConfig, profile);
        return createInstance(sdk, profile);
      },
      ...(spec.findOrCreate !== undefined
        ? {
            findOrCreate: async (scope: string, profile: SandboxProfile) => {
              const unsupported = detectUnsupportedProfileFields(profile);
              if (unsupported !== undefined) {
                throw new Error(formatUnsupportedProfileError(spec.name, unsupported));
              }
              const findOrCreateFn = spec.findOrCreate;
              if (findOrCreateFn === undefined) {
                throw new Error("findOrCreate is undefined");
              }
              const sdk = await findOrCreateFn(resolvedConfig, scope, profile);
              return createInstance(sdk, profile);
            },
          }
        : {}),
    },
  };
}
