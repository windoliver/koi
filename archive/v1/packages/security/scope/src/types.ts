/**
 * Scope configuration types — define what each consumer is allowed to see.
 *
 * Each scope type is a declarative policy: the proxy wrappers in this package
 * compile these into efficient runtime forms at construction time.
 */

import type { ToolPolicy } from "@koi/core";
import type { NavigationSecurityConfig } from "./url-security.js";

// ---------------------------------------------------------------------------
// Filesystem scope
// ---------------------------------------------------------------------------

export interface FileSystemScope {
  readonly root: string;
  readonly mode: "rw" | "ro";
}

/** Pre-compiled filesystem scope for efficient per-call path validation. */
export interface CompiledFileSystemScope {
  /** Absolute, normalized root path. */
  readonly root: string;
  /** root + path.sep — for efficient startsWith boundary check. */
  readonly rootWithSep: string;
  readonly mode: "rw" | "ro";
}

// ---------------------------------------------------------------------------
// Browser scope
// ---------------------------------------------------------------------------

export interface BrowserScope {
  readonly navigation: NavigationSecurityConfig;
  readonly policy?: ToolPolicy;
}

// ---------------------------------------------------------------------------
// Credentials scope
// ---------------------------------------------------------------------------

export interface CredentialsScope {
  readonly keyPattern: string;
}

/** Pre-compiled credentials scope with RegExp for efficient per-call matching. */
export interface CompiledCredentialsScope {
  readonly pattern: RegExp;
  readonly originalPattern: string;
}

// ---------------------------------------------------------------------------
// Memory scope
// ---------------------------------------------------------------------------

export interface MemoryScope {
  readonly namespace: string;
}
