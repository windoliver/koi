/**
 * Theme Zustand store — tracks dark/light/system preference.
 *
 * Persists to localStorage and applies the resolved theme to
 * document.documentElement.dataset.theme for CSS variable switching.
 */

import { create } from "zustand";

const STORAGE_KEY = "koi-dashboard-theme";

type ThemePreference = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

export interface ThemeStoreState {
  readonly theme: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly setTheme: (theme: ThemePreference) => void;
  readonly toggle: () => void;
  /** Apply resolvedTheme to DOM — called on mount and on change. */
  readonly applyTheme: () => void;
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return getSystemTheme();
  return preference;
}

function loadPersistedTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "system") {
    return stored;
  }
  return "system";
}

function persistTheme(theme: ThemePreference): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, theme);
}

function applyToDOM(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolved;
}

const TOGGLE_CYCLE: Record<ThemePreference, ThemePreference> = {
  dark: "light",
  light: "system",
  system: "dark",
} as const;

const initialTheme = loadPersistedTheme();
const initialResolved = resolveTheme(initialTheme);

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  theme: initialTheme,
  resolvedTheme: initialResolved,

  setTheme: (theme) => {
    const resolved = resolveTheme(theme);
    persistTheme(theme);
    applyToDOM(resolved);
    set({ theme, resolvedTheme: resolved });
  },

  toggle: () => {
    const current = get().theme;
    const next = TOGGLE_CYCLE[current];
    get().setTheme(next);
  },

  applyTheme: () => {
    applyToDOM(get().resolvedTheme);
  },
}));
