/**
 * Browser auto-detection utility.
 *
 * Checks common OS install paths for Chrome, Brave, Edge, and Chromium,
 * plus Playwright's own bundled Chromium. Returns all found browsers sorted
 * by preference (bundled Playwright Chromium last — it's the safe fallback).
 *
 * Pure function — no side effects, never throws. Returns empty array when
 * nothing is found.
 */

import { existsSync } from "node:fs";
import { platform } from "node:os";
import { chromium } from "playwright";

export interface DetectedBrowser {
  /** Human-readable name (e.g. "Google Chrome", "Playwright Chromium"). */
  readonly name: string;
  /** Absolute path to the browser executable. */
  readonly executablePath: string;
  /** Detection source: system path check or Playwright bundled. */
  readonly source: "system" | "playwright-bundled";
}

// ---------------------------------------------------------------------------
// Platform-specific candidate paths
// ---------------------------------------------------------------------------

type OsPlatform = "darwin" | "linux" | "win32";

const CANDIDATES: Record<OsPlatform, readonly { name: string; path: string }[]> = {
  darwin: [
    {
      name: "Google Chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    { name: "Brave Browser", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    {
      name: "Microsoft Edge",
      path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    },
    { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
    {
      name: "Google Chrome Canary",
      path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    },
  ],
  linux: [
    { name: "Google Chrome", path: "/usr/bin/google-chrome" },
    { name: "Google Chrome (stable)", path: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", path: "/usr/bin/chromium" },
    { name: "Chromium (browser)", path: "/usr/bin/chromium-browser" },
    { name: "Brave Browser", path: "/usr/bin/brave-browser" },
    { name: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
    { name: "Microsoft Edge (stable)", path: "/usr/bin/microsoft-edge-stable" },
  ],
  win32: [
    {
      name: "Google Chrome",
      path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    },
    {
      name: "Google Chrome (x86)",
      path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    },
    {
      name: "Microsoft Edge",
      path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    },
    {
      name: "Brave Browser",
      path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    },
    { name: "Chromium", path: "C:\\Program Files\\Chromium\\Application\\chrome.exe" },
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect all available Chromium-family browsers on this machine.
 *
 * Results are sorted: system browsers first (user preference), then
 * Playwright's bundled Chromium as the reliable fallback.
 *
 * Never throws — returns [] if nothing is found.
 */
export async function detectInstalledBrowsers(): Promise<readonly DetectedBrowser[]> {
  const os = platform() as OsPlatform;
  const candidates = CANDIDATES[os] ?? [];

  const found: DetectedBrowser[] = [];

  for (const { name, path } of candidates) {
    if (existsSync(path)) {
      found.push({ name, executablePath: path, source: "system" });
    }
  }

  // Playwright bundled Chromium — always available when playwright is installed
  try {
    const bundledPath = chromium.executablePath();
    if (bundledPath && existsSync(bundledPath)) {
      found.push({
        name: "Playwright Chromium",
        executablePath: bundledPath,
        source: "playwright-bundled",
      });
    }
  } catch (_e: unknown) {
    // Best-effort detection: Playwright not installed or chromium not downloaded — skip silently.
  }

  return found;
}
