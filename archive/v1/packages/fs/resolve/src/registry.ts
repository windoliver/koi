/**
 * Brick descriptor registry — maps (kind, name) pairs to descriptors.
 *
 * Immutable after creation. Supports canonical names and aliases.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolveKind, ResolveRegistry } from "./types.js";

/** Composite key for the lookup map. */
function registryKey(kind: ResolveKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * Creates an immutable registry from a list of descriptors.
 *
 * Validates no duplicate (kind, name) or (kind, alias) collisions.
 * Returns a Result — fails fast on duplicates.
 */
export function createRegistry(
  descriptors: readonly BrickDescriptor<unknown>[],
): Result<ResolveRegistry, KoiError> {
  const byKey = new Map<string, BrickDescriptor<unknown>>();
  const byKind = new Map<ResolveKind, BrickDescriptor<unknown>[]>();

  for (const descriptor of descriptors) {
    const key = registryKey(descriptor.kind, descriptor.name);

    // Check canonical name collision
    if (byKey.has(key)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Duplicate descriptor: (${descriptor.kind}, "${descriptor.name}") is already registered`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    byKey.set(key, descriptor);

    // Register aliases
    if (descriptor.aliases) {
      for (const alias of descriptor.aliases) {
        const aliasKey = registryKey(descriptor.kind, alias);
        if (byKey.has(aliasKey)) {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message: `Duplicate alias: (${descriptor.kind}, "${alias}") collides with an existing name or alias`,
              retryable: RETRYABLE_DEFAULTS.VALIDATION,
            },
          };
        }
        byKey.set(aliasKey, descriptor);
      }
    }

    // Index by kind
    const kindList = byKind.get(descriptor.kind);
    if (kindList) {
      kindList.push(descriptor);
    } else {
      byKind.set(descriptor.kind, [descriptor]);
    }
  }

  return {
    ok: true,
    value: {
      get(kind: ResolveKind, name: string): BrickDescriptor<unknown> | undefined {
        return byKey.get(registryKey(kind, name));
      },

      has(kind: ResolveKind, name: string): boolean {
        return byKey.has(registryKey(kind, name));
      },

      list(kind: ResolveKind): readonly BrickDescriptor<unknown>[] {
        return byKind.get(kind) ?? [];
      },
    },
  };
}
