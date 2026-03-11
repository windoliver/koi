/**
 * ACE store accessor — shared WeakMap for cross-layer store sharing.
 *
 * Extracted to its own module to avoid circular imports between ace.ts
 * (which creates middleware) and descriptor.ts (which also creates middleware
 * via the descriptor factory). Both call `trackAceStores()` after creation.
 *
 * WeakMap ensures no memory leaks — middleware GC → entry removed.
 */

import type { KoiMiddleware } from "@koi/core";
import type { PlaybookStore, StructuredPlaybookStore } from "./stores.js";

export interface AceStores {
  readonly playbookStore: PlaybookStore;
  readonly structuredPlaybookStore?: StructuredPlaybookStore | undefined;
}

const middlewareStores = new WeakMap<KoiMiddleware, AceStores>();

/**
 * Track stores for a middleware instance so L3 code can retrieve them
 * via `getAceStores()` without exposing internals on the middleware interface.
 */
export function trackAceStores(middleware: KoiMiddleware, stores: AceStores): void {
  middlewareStores.set(middleware, stores);
}

/**
 * Retrieve the stores associated with an ACE middleware instance.
 * Works for both descriptor-created and direct `createAceMiddleware()` instances.
 * Returns undefined if the middleware wasn't created through a tracked path.
 */
export function getAceStores(middleware: KoiMiddleware): AceStores | undefined {
  return middlewareStores.get(middleware);
}
