// packages/sandbox/sandbox-conformance/src/index.ts

import { describe } from "bun:test";
import type { SandboxAdapter, SandboxProfile } from "@koi/core";
import { describeCapabilityHonestyConformance } from "./capability-honesty.js";
import { describeCreateDestroyConformance } from "./create-destroy.js";
import { describeLifecycleConformance } from "./lifecycle.js";

export { describeCapabilityHonestyConformance } from "./capability-honesty.js";
export { describeCreateDestroyConformance } from "./create-destroy.js";
export { describeLifecycleConformance } from "./lifecycle.js";

/**
 * Run every conformance group an L2 adapter package should pass.
 *
 * Usage from an adapter package:
 *
 *   import { describeSandboxConformance } from "@koi/sandbox-conformance";
 *   import { createMyAdapter } from "../my-adapter.js";
 *   describeSandboxConformance(
 *     "my-adapter",
 *     () => createMyAdapter(...),
 *     () => myMinimalProfile,
 *   );
 *
 * `factory` MUST return a fresh, never-init'd adapter on each call.
 * `profile` MUST return a profile the adapter accepts.
 */
export function describeSandboxConformance(
  label: string,
  factory: () => SandboxAdapter,
  profile: () => SandboxProfile,
): void {
  describe(`SandboxAdapter conformance: ${label}`, () => {
    describeLifecycleConformance(factory);
    describeCreateDestroyConformance(factory, profile);
    describeCapabilityHonestyConformance(factory, profile);
  });
}
