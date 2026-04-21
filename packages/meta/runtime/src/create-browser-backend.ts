/**
 * createBrowserBackend — production factory that composes the two L2
 * browser driver implementations behind a single discriminated-union config.
 *
 * Callers (e.g. @koi/cli, embedded users) configure:
 *   - `kind: "playwright"` — launched Chromium via @koi/browser-playwright
 *   - `kind: "browser-ext"` — user's live Chrome via @koi/browser-ext native
 *     messaging host, composed with an auto-created Playwright delegate that
 *     connects over the extension's loopback WebSocket bridge
 *
 * Without this factory, callers had to import both L2 packages themselves and
 * hand-wire the browser-ext → browser-playwright composition (loopback bridge
 * construction, wsHeaders plumbing). The resulting driver is passed to
 * `RuntimeConfig.browser.backend` — the runtime owns dispose() lifecycle from
 * there.
 *
 * Imports of @koi/browser-playwright and @koi/browser-ext are deferred to
 * call time via dynamic import() so that the CLI bundle does not pull in
 * playwright (and its non-resolvable chromium-bidi CJS internals) at startup.
 */

import type { ExtensionDriverConfig } from "@koi/browser-ext";
import type { PlaywrightDriverConfig } from "@koi/browser-playwright";
import type { BrowserDriver } from "@koi/core";

export type BrowserBackendConfig =
  | ({
      readonly kind: "playwright";
    } & PlaywrightDriverConfig)
  | ({
      readonly kind: "browser-ext";
    } & ExtensionDriverConfig);

/**
 * Construct a BrowserDriver for `RuntimeConfig.browser.backend`.
 *
 * For `kind: "browser-ext"`, auto-composes with a Playwright delegate so
 * interaction methods (snapshot/navigate/click/…) route through the
 * extension's loopback WebSocket bridge. Callers still must call
 * `selectTargetTab(tabId, origin)` on the returned driver before the first
 * interaction — there is no implicit "first tab" fallback on a live user
 * browser (would risk mutating the wrong page).
 *
 * Disposal is owned by the runtime: do not pass the returned driver to more
 * than one runtime instance (see `RuntimeConfig.browser` docs on unshared
 * backends).
 */
export async function createBrowserBackend(config: BrowserBackendConfig): Promise<BrowserDriver> {
  switch (config.kind) {
    case "playwright": {
      const { createPlaywrightBrowserDriver } = await import("@koi/browser-playwright");
      const { kind: _kind, ...pwConfig } = config;
      return createPlaywrightBrowserDriver(pwConfig);
    }
    case "browser-ext": {
      const [{ createExtensionBrowserDriver }, { createPlaywrightBrowserDriver }] =
        await Promise.all([
          import("@koi/browser-ext"),
          import("@koi/browser-playwright"),
        ]);
      const { kind: _kind, ...extConfig } = config;
      return createExtensionBrowserDriver({
        ...extConfig,
        // Auto-compose: lazily build a Playwright delegate on first
        // interaction. The extension driver owns the delegate's lifecycle
        // (disposed when the bridge is invalidated or on driver.dispose).
        createPlaywrightDriver:
          extConfig.createPlaywrightDriver ??
          (({ wsEndpoint, wsHeaders }) => createPlaywrightBrowserDriver({ wsEndpoint, wsHeaders })),
      });
    }
  }
}
