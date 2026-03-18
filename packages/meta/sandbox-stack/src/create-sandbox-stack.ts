/**
 * Main factory for the sandbox stack.
 *
 * Composes a SandboxAdapter (injected) with a cached bridge and timeout guard
 * to produce a ready-to-use SandboxStack.
 */

import type { SandboxProfile } from "@koi/core";
import { createCachedBridge } from "@koi/sandbox-cloud-base";
import { createTimeoutGuardedExecutor } from "./timeout-guard.js";
import type { SandboxStack, SandboxStackConfig } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 60_000;

/**
 * Create a SandboxStack from a pre-created adapter.
 *
 * Returns { executor, instance, warmup, dispose }:
 * - executor: timeout-guarded SandboxExecutor
 * - instance: live getter for the cached SandboxInstance (undefined until warmup)
 * - warmup(): eagerly provisions the sandbox instance
 * - dispose(): releases all resources
 */
export function createSandboxStack(config: SandboxStackConfig): SandboxStack {
  const profile = mapConfigToProfile(config);
  const timeoutMs = config.resources?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const bridge = createCachedBridge({
    adapter: config.adapter,
    profile,
    ttlMs: config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
    scope: config.scope,
  });

  const guardedExecutor = createTimeoutGuardedExecutor(bridge, timeoutMs);

  return {
    executor: guardedExecutor,
    get instance() {
      return bridge.getInstance();
    },
    warmup: () => bridge.warmup(),
    dispose: () => bridge.dispose(),
  };
}

/** Map user-facing SandboxStackConfig → L0 SandboxProfile. */
function mapConfigToProfile(config: SandboxStackConfig): SandboxProfile {
  return {
    filesystem: {
      allowRead: ["/tmp"],
      allowWrite: ["/tmp"],
    },
    network: {
      allow: config.network?.allow ?? false,
      ...(config.network?.allowedHosts !== undefined
        ? { allowedHosts: config.network.allowedHosts }
        : {}),
    },
    resources: {
      ...(config.resources?.timeoutMs !== undefined
        ? { timeoutMs: config.resources.timeoutMs }
        : {}),
      ...(config.resources?.maxMemoryMb !== undefined
        ? { maxMemoryMb: config.resources.maxMemoryMb }
        : {}),
    },
  };
}
