/**
 * ProcFs contract — virtual filesystem for agent introspection.
 *
 * Read-only entries expose agent state lazily; writable entries
 * allow runtime tuning (e.g., priority).
 * L0 types only — implementations live in L2.
 */

// ---------------------------------------------------------------------------
// ProcEntry — lazily evaluated introspection node
// ---------------------------------------------------------------------------

/** Read-only introspection entry — lazily evaluated. */
export interface ProcEntry {
  readonly read: () => unknown | Promise<unknown>;
  readonly list?: () => readonly string[] | Promise<readonly string[]>;
}

/** Writable proc entry for runtime tuning (e.g., priority). */
export interface WritableProcEntry extends ProcEntry {
  readonly write: (value: unknown) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// ProcFs — virtual filesystem contract
// ---------------------------------------------------------------------------

/** Virtual filesystem for agent introspection and runtime tuning. */
export interface ProcFs {
  readonly mount: (path: string, entry: ProcEntry | WritableProcEntry) => void;
  readonly unmount: (path: string) => void;
  readonly read: (path: string) => unknown | Promise<unknown>;
  readonly write: (path: string, value: unknown) => void | Promise<void>;
  readonly list: (path: string) => readonly string[] | Promise<readonly string[]>;
  readonly entries: () => readonly string[];
}
