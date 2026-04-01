/**
 * Layout Zustand store — tracks responsive sidebar state.
 *
 * Manages sidebar collapsed/expanded and mobile open/closed state.
 */

import { create } from "zustand";

export interface LayoutStoreState {
  /** Whether the sidebar is collapsed to icon-only mode (tablet). */
  readonly sidebarCollapsed: boolean;
  /** Whether the mobile sidebar overlay is open. */
  readonly sidebarMobileOpen: boolean;

  readonly toggleSidebar: () => void;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  readonly setMobileOpen: (open: boolean) => void;
}

export const useLayoutStore = create<LayoutStoreState>((set) => ({
  sidebarCollapsed: false,
  sidebarMobileOpen: false,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setMobileOpen: (open) => set({ sidebarMobileOpen: open }),
}));
