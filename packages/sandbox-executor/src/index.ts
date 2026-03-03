/**
 * @koi/sandbox-executor — Sandbox executor backends (L2).
 *
 * Provides subprocess-based executor for sandbox verification and
 * promoted (in-process) executor for runtime execution.
 */

export { createPromotedExecutor } from "./promoted-executor.js";
export type { SandboxPlatform } from "./subprocess-executor.js";
export { createSubprocessExecutor, detectSandboxPlatform } from "./subprocess-executor.js";
