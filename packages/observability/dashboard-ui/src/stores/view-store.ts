/**
 * Saved view Zustand store — tracks which view filter is active.
 *
 * Views filter the file tree to show subsets (agents, events, sessions, etc.).
 * Default is "all" which shows the entire Nexus namespace.
 */

import type { SavedViewDefinition } from "@koi/dashboard-types";
import { SAVED_VIEWS } from "@koi/dashboard-types";
import { create } from "zustand";

export interface ViewStoreState {
  /** Currently active saved view ID. */
  readonly activeViewId: string;
  /** Resolved view definition (derived from activeViewId). */
  readonly activeView: SavedViewDefinition;

  readonly setActiveView: (viewId: string) => void;
}

// SAVED_VIEWS is a non-empty readonly array defined in @koi/dashboard-types.
// Provide an inline fallback so TS can narrow away `undefined` without `!` or `as`.
const DEFAULT_VIEW: SavedViewDefinition = SAVED_VIEWS[0] ?? {
  id: "all",
  label: "All Files",
  rootPaths: ["/"],
  urlParam: "all",
};

function resolveView(viewId: string): SavedViewDefinition {
  return SAVED_VIEWS.find((v) => v.id === viewId) ?? DEFAULT_VIEW;
}

export const useViewStore = create<ViewStoreState>((set) => ({
  activeViewId: "all",
  activeView: DEFAULT_VIEW,

  setActiveView: (viewId) =>
    set({
      activeViewId: viewId,
      activeView: resolveView(viewId),
    }),
}));
