/**
 * Post-composition invariant enforcer for the required middleware set.
 *
 * Runs after `composeRuntimeMiddleware` and before the runtime boots.
 * Asserts that every security-critical layer the host requires is
 * actually present in the composed chain, refusing to start otherwise.
 *
 * This is the last line of defense against two classes of bug:
 *
 *   1. A manifest that attempts to omit or reorder a core layer. The
 *      manifest loader rejects core names in `manifest.middleware`
 *      (zone B), so in practice this path only matters if a host
 *      forgets to pass a required layer to the composer.
 *
 *   2. A programmatic caller of `createKoiRuntime` that constructs a
 *      custom middleware list. The enforcer runs regardless of
 *      whether a manifest was used, so these callers get the same
 *      safety.
 *
 * Opt-outs are deliberately NOT supported here. An earlier design
 * exposed a `trustedHost` surface that let hosts relax the baseline
 * via per-layer flags, but the flags were never wired into runtime
 * assembly, which meant the API advertised behavior the runtime did
 * not provide. The whole opt-out path has been removed until there
 * is a genuine end-to-end implementation. Hosts that need a
 * headless/CI posture today construct the runtime with a custom
 * middleware list + pre-composed security stance, bypassing this
 * enforcer.
 */

import type { KoiMiddleware } from "@koi/core";

/**
 * Canonical names of the three required security layers, matching the
 * middleware `.name` field set by each package:
 *   - `hooks`             — @koi/hooks (packages/lib/hooks/src/middleware.ts:515)
 *   - `permissions`       — @koi/permissions (packages/security/middleware-permissions)
 *   - `exfiltration-guard`— @koi/middleware-exfiltration-guard
 *
 * The `hooks` name is plural because that middleware dispatches the
 * full hooks surface (pre-run, post-run, etc.), not a single hook.
 */
export const REQUIRED_MIDDLEWARE_NAMES = {
  hooks: "hooks",
  permissions: "permissions",
  exfiltrationGuard: "exfiltration-guard",
} as const;

export interface EnforceRequiredOptions {
  /**
   * Whether this runtime ships terminal-capable tools (shell, web_fetch,
   * bash, etc.). Terminal-capable runtimes require the full security
   * baseline including `permissions` and `exfiltration-guard`. Headless
   * runtimes (e.g. embedded analysis agents) may be allowed to boot
   * without the terminal-only layers, but `hooks` is always required.
   */
  readonly terminalCapable: boolean;
}

export class RequiredMiddlewareError extends Error {
  override readonly name = "RequiredMiddlewareError";
  readonly missing: readonly string[];
  readonly terminalCapable: boolean;
  constructor(missing: readonly string[], terminalCapable: boolean) {
    super(
      `required middleware missing from composed chain: ${missing.join(", ")} (terminalCapable=${terminalCapable}). ` +
        "core layers cannot be omitted via manifest — if you are constructing the chain programmatically, include the required layer.",
    );
    this.missing = missing;
    this.terminalCapable = terminalCapable;
  }
}

/**
 * Assert that every required middleware layer is present in the
 * composed chain. Throws `RequiredMiddlewareError` if a required
 * layer is missing.
 */
export function enforceRequiredMiddleware(
  chain: readonly KoiMiddleware[],
  options: EnforceRequiredOptions,
): void {
  const { terminalCapable } = options;
  const present = new Set(chain.map((mw) => mw.name));

  const missing: string[] = [];

  // `hooks` is always required — it's the dispatch surface for plugins.
  if (!present.has(REQUIRED_MIDDLEWARE_NAMES.hooks)) {
    missing.push(REQUIRED_MIDDLEWARE_NAMES.hooks);
  }

  if (terminalCapable) {
    if (!present.has(REQUIRED_MIDDLEWARE_NAMES.permissions)) {
      missing.push(REQUIRED_MIDDLEWARE_NAMES.permissions);
    }
    if (!present.has(REQUIRED_MIDDLEWARE_NAMES.exfiltrationGuard)) {
      missing.push(REQUIRED_MIDDLEWARE_NAMES.exfiltrationGuard);
    }
  }

  if (missing.length > 0) {
    throw new RequiredMiddlewareError(missing, terminalCapable);
  }
}
