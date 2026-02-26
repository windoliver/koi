/**
 * @koi/scope — Linux namespace-style scoped component views (L0u)
 *
 * Provides capability-attenuation wrappers for infrastructure tokens:
 * filesystem (path root + rw/ro), browser (URL allowlist + trust tier),
 * credentials (key glob filter), and memory (namespace isolation).
 *
 * Each wrapper compiles its scope config once at construction and
 * validates per-call with minimal overhead. You can only narrow
 * access, never widen it.
 *
 * Depends on @koi/core only.
 */

// enforced backends — pluggable policy enforcement on top of scoped backends
export {
  createEnforcedBrowser,
  createEnforcedCredentials,
  createEnforcedFileSystem,
  createEnforcedMemory,
} from "./enforced-backends.js";
// scoped browser
export type { CompiledBrowserScope } from "./scoped-browser.js";
export { compileBrowserScope, createScopedBrowser } from "./scoped-browser.js";
// scoped credentials
export {
  compileCredentialsScope,
  createScopedCredentials,
  createScopedCredentialsProvider,
} from "./scoped-credentials.js";

// scoped filesystem
export { compileFileSystemScope, createScopedFileSystem } from "./scoped-filesystem.js";
// scoped memory
export { createScopedMemory, createScopedMemoryProvider } from "./scoped-memory.js";
// scope config types
export type {
  BrowserScope,
  CompiledCredentialsScope,
  CompiledFileSystemScope,
  CredentialsScope,
  FileSystemScope,
  MemoryScope,
} from "./types.js";
// url security (canonical home — re-exported by @koi/tool-browser)
export type { CompiledNavigationSecurity, NavigationSecurityConfig } from "./url-security.js";
export {
  compileNavigationSecurity,
  parseSecureOptionalUrl,
  parseSecureUrl,
} from "./url-security.js";
