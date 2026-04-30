/**
 * @koi/governance-scope — capability-attenuation wrappers (gov-15).
 *
 * Wraps infrastructure providers so a tool granted access only sees the
 * sliver permitted by scope config:
 *   - Filesystem: glob allowlist + ro/rw mode
 *   - Fetcher: URLPattern allowlist (composes with @koi/url-safety)
 *   - Credentials: key glob allowlist (least-information)
 *
 * Tools cannot escape their mandate; even if a tool is compromised or
 * prompt-injected, blast radius is bounded. All wrappers fail closed.
 */

export type { ScopedCredentialsOptions } from "./scoped-credentials.js";
export { createScopedCredentials } from "./scoped-credentials.js";

export type { ScopedFetcherOptions } from "./scoped-fetcher.js";
export { createScopedFetcher } from "./scoped-fetcher.js";
export type { CompiledScopedFs, ScopedFsOptions } from "./scoped-fs.js";
export { compileScopedFs, createScopedFs } from "./scoped-fs.js";
