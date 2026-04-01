import { beforeEach, describe, expect, test } from "bun:test";
import { useLayoutStore } from "./layout-store.js";

describe("layout-store", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      sidebarCollapsed: false,
      sidebarMobileOpen: false,
    });
  });

  test("toggleSidebar flips collapsed state", () => {
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false);
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true);
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false);
  });

  test("setSidebarCollapsed sets collapsed to true", () => {
    useLayoutStore.getState().setSidebarCollapsed(true);
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true);
  });

  test("setSidebarCollapsed sets collapsed to false", () => {
    useLayoutStore.getState().setSidebarCollapsed(true);
    useLayoutStore.getState().setSidebarCollapsed(false);
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false);
  });

  test("setMobileOpen opens mobile sidebar", () => {
    useLayoutStore.getState().setMobileOpen(true);
    expect(useLayoutStore.getState().sidebarMobileOpen).toBe(true);
  });

  test("setMobileOpen closes mobile sidebar", () => {
    useLayoutStore.getState().setMobileOpen(true);
    useLayoutStore.getState().setMobileOpen(false);
    expect(useLayoutStore.getState().sidebarMobileOpen).toBe(false);
  });
});
