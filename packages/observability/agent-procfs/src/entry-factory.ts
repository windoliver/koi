/**
 * Entry factory — creates ProcEntry instances from declarative EntryDefinition objects.
 *
 * Binds an EntryContext (agent + registry) to each definition's callbacks,
 * producing ProcEntry or WritableProcEntry instances ready for mounting.
 */

import type { ProcEntry, WritableProcEntry } from "@koi/core";
import type { EntryContext, EntryDefinition } from "./entry-definitions.js";

// ---------------------------------------------------------------------------
// Factory result
// ---------------------------------------------------------------------------

export interface FactoryEntry {
  readonly path: string;
  readonly entry: ProcEntry | WritableProcEntry;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create ProcEntry instances from definitions, bound to a specific agent context.
 *
 * Returns an array of { path, entry } pairs ready for mounting in ProcFs.
 */
export function createEntriesFromDefinitions(
  definitions: readonly EntryDefinition[],
  ctx: EntryContext,
): readonly FactoryEntry[] {
  return definitions.map((def) => ({
    path: def.path,
    entry: createEntry(def, ctx),
  }));
}

function createEntry(def: EntryDefinition, ctx: EntryContext): ProcEntry | WritableProcEntry {
  const listFn = def.list;
  const base: ProcEntry = {
    read: () => def.read(ctx),
    ...(listFn !== undefined ? { list: () => listFn(ctx) } : {}),
  };

  const writeFn = def.write;
  if (writeFn !== undefined) {
    const writable: WritableProcEntry = {
      ...base,
      write: (value: unknown) => writeFn(ctx, value),
    };
    return writable;
  }

  return base;
}
