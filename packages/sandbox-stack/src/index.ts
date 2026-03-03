/**
 * @koi/sandbox-stack — L3 composition bundle for sandboxed code execution.
 *
 * Gives any agent a one-call createSandboxStack() factory, an optional
 * execute_code tool provider, and a timeout-guarded executor.
 *
 * Adapters are injected — this bundle has zero direct dependency on any
 * specific sandbox backend (Docker, E2B, Cloudflare, etc.).
 */

export { createSandboxStack } from "./create-sandbox-stack.js";
export { createExecuteCodeProvider } from "./execute-code-tool.js";
export { createTimeoutGuardedExecutor } from "./timeout-guard.js";
export type { SandboxStack, SandboxStackConfig } from "./types.js";
