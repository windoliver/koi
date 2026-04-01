import { beforeEach, describe, expect, test } from "bun:test";
import { useThemeStore } from "./theme-store.js";

describe("theme-store", () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({
      theme: "system",
      resolvedTheme: "dark",
    });
  });

  test("initial theme defaults to system", () => {
    const { theme } = useThemeStore.getState();
    // After reset, should be "system"
    expect(theme).toBe("system");
  });

  test("setTheme persists to localStorage", () => {
    useThemeStore.getState().setTheme("light");
    expect(localStorage.getItem("koi-dashboard-theme")).toBe("light");
    expect(useThemeStore.getState().theme).toBe("light");
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });

  test("setTheme dark sets resolvedTheme to dark", () => {
    useThemeStore.getState().setTheme("dark");
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  });

  test("toggle cycles dark -> light -> system -> dark", () => {
    useThemeStore.getState().setTheme("dark");
    expect(useThemeStore.getState().theme).toBe("dark");

    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().theme).toBe("light");

    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().theme).toBe("system");

    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  test("applyTheme sets data-theme attribute on document element", () => {
    useThemeStore.getState().setTheme("light");
    useThemeStore.getState().applyTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("setTheme applies to DOM immediately", () => {
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
