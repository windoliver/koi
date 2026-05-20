/**
 * Shared context namespace contract.
 *
 * L0 types only: implementations live in L0u/L2 packages and may be
 * in-memory, local filesystem-backed, or Nexus-backed.
 */

import type { FileSystemBackend } from "./filesystem-backend.js";

/** Namespace-level access grant for mounted context backends. */
export type ContextNamespaceAccessMode = "ro" | "rw";

/** Mounted backend metadata for a shared context namespace path. */
export interface ContextNamespaceMount {
  /** Stable absolute namespace path, e.g. "/shared". */
  readonly path: string;
  /** Backend mounted under the namespace path. */
  readonly backend: FileSystemBackend;
  /** Access mode applied to this namespace mount. */
  readonly mode: ContextNamespaceAccessMode;
  /** Optional implementation-specific metadata such as ReBAC grant IDs. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Change event emitted by a context namespace implementation. */
export type ContextNamespaceChangeEvent =
  | {
      readonly kind: "mounted";
      readonly path: string;
      readonly mode: ContextNamespaceAccessMode;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    }
  | {
      readonly kind: "unmounted";
      readonly path: string;
    }
  | {
      readonly kind: "resolved";
      readonly path: string;
      readonly mountPath: string;
      readonly mode: ContextNamespaceAccessMode;
    };

/**
 * Mount table for shared agent context.
 *
 * Agents use this as a world service: a parent and child may receive the
 * same namespace instance, but no direct agent-to-agent channel is implied.
 */
export interface ContextNamespace {
  readonly mount: (mount: ContextNamespaceMount) => void | Promise<void>;
  readonly unmount: (path: string) => boolean | Promise<boolean>;
  readonly resolve: (
    path: string,
  ) => FileSystemBackend | undefined | Promise<FileSystemBackend | undefined>;
  readonly list: () => readonly ContextNamespaceMount[] | Promise<readonly ContextNamespaceMount[]>;
  readonly watch?: (listener: (event: ContextNamespaceChangeEvent) => void) => () => void;
}
