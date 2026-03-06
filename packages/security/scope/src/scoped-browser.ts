/**
 * Scoped browser wrapper — restricts a BrowserDriver to allowed domains,
 * protocols, and trust tiers.
 *
 * Uses the same NavigationSecurityConfig compilation as url-security.ts.
 * The compiled security config is created once at construction time.
 *
 * **Redirect boundary:** This wrapper validates the *requested* URL only.
 * Post-navigation redirects (HTTP 3xx, meta-refresh, JS-triggered navigation)
 * are the BrowserDriver's responsibility. For full redirect enforcement,
 * configure the driver to intercept navigation events (e.g., Playwright
 * `page.route()`) with the same domain allowlist.
 */

import type { BrowserDriver, KoiError, Result } from "@koi/core";
import { permission } from "@koi/core";
import type { BrowserScope } from "./types.js";
import {
  type CompiledNavigationSecurity,
  compileNavigationSecurity,
  runSecurityChecks,
} from "./url-security.js";

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface CompiledBrowserScope {
  readonly navigation: CompiledNavigationSecurity;
  readonly policy: BrowserScope["policy"];
}

export function compileBrowserScope(scope: BrowserScope): CompiledBrowserScope {
  return {
    navigation: compileNavigationSecurity(scope.navigation),
    policy: scope.policy,
  };
}

// ---------------------------------------------------------------------------
// URL validation helper
// ---------------------------------------------------------------------------

function validateUrl(url: string, compiled: CompiledBrowserScope): KoiError | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return permission(
      `Navigation to "${url}" was blocked: not a valid URL. ` +
        `Provide a full URL including scheme (e.g. https://example.com).`,
    );
  }
  const err = runSecurityChecks(parsed, compiled.navigation);
  if (err !== undefined) {
    return permission(err.error);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScopedBrowser(driver: BrowserDriver, scope: BrowserScope): BrowserDriver {
  const compiled = compileBrowserScope(scope);

  // Build optional method objects conditionally to satisfy exactOptionalPropertyTypes.
  // Capture method references to avoid non-null assertions in the delegating closures.
  const upload = driver.upload;
  const scopedUpload: Pick<BrowserDriver, "upload"> = upload
    ? { upload: (ref, files, options) => upload(ref, files, options) }
    : {};

  const traceStart = driver.traceStart;
  const scopedTraceStart: Pick<BrowserDriver, "traceStart"> = traceStart
    ? { traceStart: (options) => traceStart(options) }
    : {};

  const traceStop = driver.traceStop;
  const scopedTraceStop: Pick<BrowserDriver, "traceStop"> = traceStop
    ? { traceStop: () => traceStop() }
    : {};

  const dispose = driver.dispose;
  const scopedDispose: Pick<BrowserDriver, "dispose"> = dispose ? { dispose: () => dispose() } : {};

  return {
    name: `scoped(${driver.name})`,

    snapshot(options) {
      return driver.snapshot(options);
    },

    navigate(url, options) {
      const err = validateUrl(url, compiled);
      if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      return driver.navigate(url, options);
    },

    click(ref, options) {
      return driver.click(ref, options);
    },

    type(ref, value, options) {
      return driver.type(ref, value, options);
    },

    select(ref, value, options) {
      return driver.select(ref, value, options);
    },

    fillForm(fields, options) {
      return driver.fillForm(fields, options);
    },

    scroll(options) {
      return driver.scroll(options);
    },

    screenshot(options) {
      return driver.screenshot(options);
    },

    wait(options) {
      return driver.wait(options);
    },

    tabNew(options) {
      if (options?.url !== undefined) {
        const err = validateUrl(options.url, compiled);
        if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      }
      return driver.tabNew(options);
    },

    tabClose(tabId, options) {
      return driver.tabClose(tabId, options);
    },

    tabFocus(tabId, options) {
      return driver.tabFocus(tabId, options);
    },

    evaluate(script, options) {
      if (compiled.policy?.sandbox !== false) {
        return {
          ok: false,
          error: permission(
            `evaluate() was blocked: requires unsandboxed policy but tool is sandboxed. ` +
              `Only unsandboxed agents may execute arbitrary JavaScript in the browser.`,
          ),
        } satisfies Result<never, KoiError>;
      }
      return driver.evaluate(script, options);
    },

    hover(ref, options) {
      return driver.hover(ref, options);
    },

    press(key, options) {
      return driver.press(key, options);
    },

    tabList() {
      return driver.tabList();
    },

    console(options) {
      return driver.console(options);
    },

    ...scopedUpload,
    ...scopedTraceStart,
    ...scopedTraceStop,
    ...scopedDispose,
  };
}
