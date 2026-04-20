/**
 * Playwright implementation of BrowserDriver.
 *
 * Single persistent Browser + BrowserContext per driver instance.
 * Pages (tabs) are tracked in a Map<tabId, Page>.
 *
 * Per-tab snapshot state: each tab has its own snapshotId, refs, and
 * refCounter — switching tabs does not invalidate another tab's refs.
 *
 * Ref resolution priority:
 *   1. Native aria-ref → page.locator('[aria-ref="..."]') — O(1) direct lookup
 *   2. getByRole(role, {name}).nth(nthIndex) — fallback with nth deduplication
 *
 * CDP connection: set cdpEndpoint to connect to an existing Chrome instance.
 * Stealth: set stealth:true to hide navigator.webdriver and disable AutomationControlled.
 */

import { promises as dnsPromises } from "node:dns";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAriaYaml, translatePlaywrightError, VALID_ROLES } from "@koi/browser-a11y";
import type {
  BrowserActionOptions,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserConsoleOptions,
  BrowserConsoleResult,
  BrowserDriver,
  BrowserEvaluateOptions,
  BrowserEvaluateResult,
  BrowserFormField,
  BrowserNavigateOptions,
  BrowserNavigateResult,
  BrowserRefInfo,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserScrollOptions,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserTabCloseOptions,
  BrowserTabFocusOptions,
  BrowserTabInfo,
  BrowserTabNewOptions,
  BrowserTraceOptions,
  BrowserTraceResult,
  BrowserTypeOptions,
  BrowserUploadFile,
  BrowserUploadOptions,
  BrowserWaitOptions,
  KoiError,
  Result,
} from "@koi/core";
import { internal, notFound, permission, staleRef, validation } from "@koi/core";
import type { Browser, BrowserContext, FrameLocator, Locator, Page } from "playwright";
import { chromium } from "playwright";

/** Playwright-typed role guard — same validation as isAriaRole, returns Playwright's AriaRole. */
type AriaRole = Parameters<Page["getByRole"]>[0];
function isAriaRole(role: string): role is AriaRole {
  return VALID_ROLES.has(role);
}

export interface PlaywrightDriverConfig {
  /**
   * Inject an already-launched Browser instance.
   * When provided, `dispose()` will NOT close this browser — the caller manages lifecycle.
   */
  readonly browser?: Browser;
  /**
   * Connect to an existing Chrome/Chromium instance via CDP.
   * Example: "ws://localhost:9222" (start Chrome with --remote-debugging-port=9222).
   * When provided, `dispose()` will NOT close the browser — the caller manages lifecycle.
   * Ignored when `browser` is provided.
   */
  readonly cdpEndpoint?: string;
  /**
   * Connect to a CDP WebSocket endpoint (e.g. ws://127.0.0.1:<port>/...). When set,
   * takes precedence over `cdpEndpoint`. Used by `@koi/browser-ext` to connect via a
   * loopback WebSocket bridged to a Chrome extension's chrome.debugger API through
   * a Koi native messaging host.
   *
   * Passed as the first argument to Playwright's `chromium.connectOverCDP(endpointURL, options)`
   * — the modern non-deprecated form.
   */
  readonly wsEndpoint?: string;
  /**
   * Optional HTTP headers to send with the CDP WebSocket upgrade. Required when the
   * target endpoint enforces auth (e.g. `@koi/browser-ext`'s loopback bridge requires
   * `Authorization: Bearer <token>` per spec §7.1). Forwarded verbatim to Playwright's
   * `connectOverCDP(..., { headers })` option.
   */
  readonly wsHeaders?: Readonly<Record<string, string>>;
  /** Run headless (default: true). Ignored when `browser`, `cdpEndpoint`, or `wsEndpoint` is provided. */
  readonly headless?: boolean;
  /** Browser launch timeout in ms (default: 30000). Ignored when `browser`, `cdpEndpoint`, or `wsEndpoint` is provided. */
  readonly launchTimeout?: number;
  /**
   * Enable basic stealth mode (default: false).
   * Applies Chromium launch flags and injects navigator/chrome patches.
   * Covers common bot detection: navigator.webdriver, AutomationControlled flag,
   * navigator.plugins, navigator.languages, window.chrome runtime stub.
   * Ignored when `browser`, `cdpEndpoint`, or `wsEndpoint` is provided (caller controls stealth).
   */
  readonly stealth?: boolean;
  /**
   * Absolute path to a Chromium user data directory for persistent profiles.
   * Reuses cookies, localStorage, IndexedDB, and extensions across driver instances.
   * Uses `chromium.launchPersistentContext()` — mutually exclusive with `browser` and
   * `cdpEndpoint` (those options take precedence if also provided).
   * Example: '/Users/alice/.koi/profiles/work'
   */
  readonly userDataDir?: string;
  /**
   * Block navigations that resolve to private/link-local IP addresses.
   * Prevents DNS rebinding attacks by re-resolving hostnames at request time.
   * Default: true (secure by default).
   */
  readonly blockPrivateAddresses?: boolean;
}

// Timeout defaults and maximum caps (ms)
const NAVIGATE_DEFAULT_MS = 15_000;
const NAVIGATE_MAX_MS = 60_000;
const ACTION_DEFAULT_MS = 3_000;
const ACTION_MAX_MS = 10_000;
const WAIT_DEFAULT_MS = 5_000;
const WAIT_MAX_MS = 30_000;
const EVALUATE_DEFAULT_MS = 5_000;
const EVALUATE_MAX_MS = 10_000;
const LAUNCH_DEFAULT_MS = 30_000;

/**
 * Maximum entries per tab before FIFO eviction kicks in.
 * 200 entries is enough context for agent debugging without unbounded growth.
 * In practice, agents inspect the last 50 entries (console() default limit).
 */
const CONSOLE_BUFFER_CAP = 200;

// ---------------------------------------------------------------------------
// DNS rebinding protection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the IP address falls within a private, loopback, or link-local range.
 * Used by the DNS rebinding route guard to block navigations that resolve to
 * internal addresses — catches post-TTL rebinding that bypasses static URL analysis.
 *
 * Inlined here (not imported from @koi/tool-browser) to avoid L2 peer violations.
 */
function isPrivateIpv4(ip: string): boolean {
  return (
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    ip === "0.0.0.0"
  );
}

/** Decodes `::ffff:AABB:CCDD` (Node's normalized form of IPv4-mapped IPv6) to dotted-quad. */
function ipv4FromMappedHex(lower: string): string | null {
  // Expect `::ffff:XXXX:XXXX` with two 1-4 hex groups after ffff.
  const m = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(lower);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4 direct
  if (isPrivateIpv4(lower)) return true;
  // IPv4-mapped IPv6 dotted-quad form — e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:([\d.]+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  // IPv4-mapped IPv6 hex form (Node's URL parser normalizes dotted to this) —
  // e.g. ::ffff:7f00:1 (which represents 127.0.0.1).
  const hexIpv4 = ipv4FromMappedHex(lower);
  if (hexIpv4) return isPrivateIpv4(hexIpv4);
  // Legacy IPv4-compatible IPv6 — e.g. ::127.0.0.1 (deprecated but still possible)
  const compat = /^::([\d.]+)$/.exec(lower);
  if (compat?.[1] && compat[1].includes(".")) return isPrivateIpv4(compat[1]);
  // IPv6 loopback / link-local / unique local
  if (lower === "::1") return true;
  if (/^fe[89ab][\da-f]?:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][\da-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // belt & suspenders for fc/fd prefix
  return false;
}

/**
 * Driver-level private-address guard. Runs on EVERY navigation before
 * `page.goto()`, regardless of whether the context is owned or borrowed.
 * This complements the context `route()` guard (which only runs on owned
 * contexts — borrowed contexts belong to the caller and can't be mutated).
 *
 * Rejects when `blockPrivateAddresses !== false` and:
 *   - the URL's hostname is a private IP literal (loopback, RFC1918, link-local, etc.).
 *   - OR the hostname resolves via DNS to a private IP at request time.
 *
 * Returns null when the URL is allowed; returns a KoiError otherwise.
 */
async function checkNavigationUrlAllowed(
  rawUrl: string,
  blockPrivateAddresses: boolean,
): Promise<KoiError | null> {
  if (blockPrivateAddresses === false) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return validation(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // Non-HTTP(S) schemes cross a larger trust boundary than SSRF alone:
    //   - file://      — local filesystem read
    //   - chrome://    — privileged browser internal pages
    //   - chrome-extension:// — extension surfaces
    //   - data:        — inline payloads (exfiltration via tainted redirects)
    //   - javascript:  — script execution context
    // Default-deny everything except `about:` (used internally for cleanup
    // parking after a private-address redirect reject). To intentionally
    // navigate to a local file or other scheme, set blockPrivateAddresses: false
    // (single combined opt-out for all driver-side navigation hardening).
    if (url.protocol === "about:") return null;
    return permission(
      `Navigation to non-HTTP(S) scheme blocked: ${url.protocol}. Set blockPrivateAddresses: false to allow file://, chrome://, etc.`,
    );
  }
  const hostname = url.hostname;
  // URL.hostname strips IPv6 brackets already; handle raw-bracket case defensively.
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // IP literal detection: IPv4 (digits + dots only) or IPv6 (contains a colon).
  const isIpLiteral =
    /^\d+(\.\d+){3}$/.test(bare) || (bare.includes(":") && /^[\da-fA-F:.]+$/.test(bare));
  if (isIpLiteral) {
    if (isPrivateIp(bare)) {
      return permission(
        `Navigation to private IP blocked: ${bare}. Set blockPrivateAddresses: false to override.`,
      );
    }
    // Public IP literal — allowed.
    return null;
  }
  // Hostname — resolve and check. "localhost" needs an explicit check because
  // DNS resolution rules vary by OS (it may return 127.0.0.1 OR ::1 OR skip DNS entirely).
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return permission(
      `Navigation to private hostname blocked: ${hostname}. Set blockPrivateAddresses: false to override.`,
    );
  }
  try {
    // Resolve ALL addresses for the hostname. A hostname that publishes both
    // public and private A/AAAA records must be denied — Node's single-address
    // lookup is not guaranteed to match the address Chromium picks.
    const addresses = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        return permission(
          `Navigation to private-address-resolving hostname blocked: ${hostname} → ${address}. Set blockPrivateAddresses: false to override.`,
        );
      }
    }
  } catch (err) {
    // DNS lookup failure → fail closed (consistent with the route() guard behavior).
    return permission(
      `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}. Fail-closed policy denies navigation.`,
    );
  }
  return null;
}

/**
 * Installs a per-page route handler that aborts navigation requests to
 * private addresses BEFORE the request is committed. Runs on every page
 * created by the driver — crucial for borrowed contexts (cdpEndpoint /
 * wsEndpoint paths where we cannot install a context-level guard).
 *
 * Unlike the context-level guard, this per-page handler also catches IP
 * literal navigations (e.g. `http://127.0.0.1/`) — the context-level
 * version deliberately skipped those assuming a tool-layer check,
 * which is not guaranteed in borrowed-context setups.
 */
async function installPageRebindingGuard(
  page: Page,
  blockPrivateAddresses: boolean,
): Promise<void> {
  if (!blockPrivateAddresses) return;
  await page.route("**", async (route) => {
    const req = route.request();
    // Only intercept main-frame document navigations — sub-resources are
    // not private-address rebinding vectors in this scope.
    if (req.resourceType() !== "document" || !req.isNavigationRequest()) {
      await route.continue();
      return;
    }
    try {
      const url = new URL(req.url());
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        // Default-deny non-HTTP(S) schemes on page-driven navigations
        // (window.location, window.open, etc.) — matches the driver-level
        // policy in checkNavigationUrlAllowed. `about:` remains allowed
        // for internal cleanup (e.g. parking after a private-address abort).
        if (url.protocol === "about:") {
          await route.continue();
          return;
        }
        await route.abort("accessdenied");
        return;
      }
      const host = url.hostname;
      const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      // IP literals (IPv4 dotted + IPv6 / IPv4-mapped IPv6).
      const isIpLiteral =
        /^\d+(\.\d+){3}$/.test(bare) || (bare.includes(":") && /^[\da-fA-F:.]+$/.test(bare));
      if (isIpLiteral) {
        if (isPrivateIp(bare)) {
          await route.abort("accessdenied");
          return;
        }
        await route.continue();
        return;
      }
      // Explicit localhost handling — DNS rules vary by OS.
      if (bare === "localhost" || bare.endsWith(".localhost")) {
        await route.abort("accessdenied");
        return;
      }
      // Resolve ALL addresses. Multi-record hostnames with mixed public/private
      // entries must be denied — Node's single-address lookup is not guaranteed
      // to match the address Chromium picks.
      const addresses = await dnsPromises.lookup(bare, { all: true, verbatim: true });
      for (const { address } of addresses) {
        if (isPrivateIp(address)) {
          await route.abort("accessdenied");
          return;
        }
      }
    } catch {
      // DNS lookup failure → fail closed (consistent with fail-closed policy elsewhere).
      await route.abort("accessdenied");
      return;
    }
    await route.continue();
  });
}

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a Playwright ConsoleMessage type string to a BrowserConsoleLevel.
 * Returns null for structural/grouping types that carry no signal for agents.
 */
function normalizeConsoleType(type: string): BrowserConsoleLevel | null {
  switch (type) {
    case "log":
    case "trace":
      return "log";
    case "warning":
      return "warning";
    case "error":
      return "error";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "assert":
      // assert fires when assertion fails — map to error for agent visibility
      return "error";
    case "dir":
    case "dirxml":
    case "table":
    case "group":
    case "groupCollapsed":
    case "groupEnd":
    case "count":
    case "countReset":
    case "time":
    case "timeLog":
    case "timeEnd":
    case "clear":
    case "startGroup":
    case "startGroupCollapsed":
    case "endGroup":
      return null;
    default:
      return "log";
  }
}

// ---------------------------------------------------------------------------
// Stealth init script — injected at BrowserContext level
// ---------------------------------------------------------------------------

/**
 * JavaScript snippet injected into every page at BrowserContext level when stealth is enabled.
 * Covers the most commonly checked bot-detection signals without any extra dependencies.
 * Exported so CDP callers can apply the same patches to their own contexts.
 */
export const STEALTH_INIT_SCRIPT = `
// 1. navigator.webdriver — primary automation flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// 2. navigator.plugins — real Chrome always has at least one plugin; headless has none
if (navigator.plugins.length === 0) {
  Object.defineProperty(navigator, 'plugins', {
    get: () => Object.setPrototypeOf(
      [{ name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 0 }],
      PluginArray.prototype
    ),
  });
}

// 3. navigator.languages — ensure realistic browser language preferences
Object.defineProperty(navigator, 'languages', { get: () => Object.freeze(['en-US', 'en']) });

// 4. window.chrome — real Chrome exposes a runtime stub; headless Chromium does not
if (typeof window.chrome === 'undefined') {
  Object.defineProperty(window, 'chrome', { value: Object.freeze({ runtime: {} }), configurable: true });
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a raw timeout option to a validated ms value.
 * Returns {ok: false} if the value exceeds maxMs, {ok: true, value: ms} otherwise.
 */
function resolveTimeout(
  raw: number | undefined,
  defaultMs: number,
  maxMs: number,
  label: string,
):
  | { readonly ok: false; readonly error: KoiError }
  | { readonly ok: true; readonly value: number } {
  const ms = raw ?? defaultMs;
  if (ms > maxMs) {
    return {
      ok: false,
      error: validation(`${label} timeout ${ms}ms exceeds maximum ${maxMs}ms`),
    };
  }
  return { ok: true, value: ms };
}

// ---------------------------------------------------------------------------
// Per-tab snapshot state
// ---------------------------------------------------------------------------

interface TabSnapshot {
  readonly snapshotId: string;
  readonly refs: Readonly<Record<string, BrowserRefInfo>>;
  readonly refCounter: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlaywrightBrowserDriver(config: PlaywrightDriverConfig = {}): BrowserDriver {
  // Whether we own the browser lifecycle (launched it ourselves)
  const ownsLifecycle = !config.browser && !config.cdpEndpoint && !config.wsEndpoint;

  let browser: Browser | null = config.browser ?? null;
  let browserContext: BrowserContext | null = null;
  // Tracks whether the current `browserContext` was borrowed from an external browser
  // (cdpEndpoint/wsEndpoint path with a pre-existing context). Borrowed contexts
  // belong to the caller — we MUST NOT install routes/init-scripts on them and
  // MUST NOT close them on dispose().
  let borrowedContext = false;
  // Promise caches prevent concurrent callers from launching two browsers/contexts.
  // Without these, two simultaneous ensureBrowser() calls would both see null and both launch.
  let browserInitPromise: Promise<Browser> | null = null; // intentional mutation: set once on first call
  let contextInitPromise: Promise<BrowserContext> | null = null; // intentional mutation: set once on first call
  let tabCounter = 0;
  const tabs = new Map<string, Page>();
  let currentTabId: string | null = null;

  // Per-tab snapshot state — replaces the old single global currentSnapshotId / currentRefs
  const tabSnapshots = new Map<string, TabSnapshot>();

  // Per-tab console log buffer (FIFO, capped at CONSOLE_BUFFER_CAP entries per tab)
  const tabConsoleLogs = new Map<string, BrowserConsoleEntry[]>();

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function newTabId(): string {
    return `tab-${++tabCounter}`;
  }

  function invalidateTabSnapshot(tabId: string): void {
    tabSnapshots.delete(tabId);
  }

  function attachConsoleListener(page: Page, tabId: string): void {
    tabConsoleLogs.set(tabId, []);
    page.on("console", (msg) => {
      const level = normalizeConsoleType(msg.type());
      if (level === null) return;
      const loc = msg.location();
      const entry: BrowserConsoleEntry = {
        level,
        text: msg.text(),
        ...(loc.url ? { url: loc.url } : {}),
        ...(loc.lineNumber ? { line: loc.lineNumber } : {}),
      };
      const buf = tabConsoleLogs.get(tabId);
      if (buf === undefined) return;
      buf.push(entry); // intentional mutation: buf is a private per-tab ring buffer owned by this closure
      if (buf.length > CONSOLE_BUFFER_CAP) buf.shift(); // intentional mutation: FIFO eviction of oldest entry
    });
  }

  async function ensureBrowser(): Promise<Browser> {
    if (browser) return browser;
    // Promise cache: concurrent callers share one launch and all await the same result.
    if (!browserInitPromise) {
      browserInitPromise = (async (): Promise<Browser> => {
        // intentional assignment: set promise cache once
        if (config.wsEndpoint && config.cdpEndpoint) {
          console.warn(
            "[@koi/browser-playwright] Both wsEndpoint and cdpEndpoint were provided; wsEndpoint takes precedence.",
          );
        }
        if (config.wsEndpoint) {
          // Use the modern string-first form — the object-form `wsEndpoint` property
          // is deprecated (Playwright recommends `endpointURL` or positional arg).
          return chromium.connectOverCDP(config.wsEndpoint, {
            timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
            ...(config.wsHeaders ? { headers: { ...config.wsHeaders } } : {}),
          });
        }
        if (config.cdpEndpoint) {
          return chromium.connectOverCDP(config.cdpEndpoint, {
            timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
          });
        }
        const launchArgs = config.stealth
          ? [
              "--disable-blink-features=AutomationControlled",
              "--no-first-run",
              "--no-default-browser-check",
            ]
          : [];
        return chromium.launch({
          headless: config.headless ?? true,
          timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
          args: launchArgs,
          ...(config.stealth ? { ignoreDefaultArgs: ["--enable-automation"] } : {}),
        });
      })();
    }
    try {
      browser = await browserInitPromise; // intentional assignment: cache resolved browser for sync access
    } catch (e: unknown) {
      browserInitPromise = null; // intentional reset: allow retry on next call instead of caching rejection forever
      throw e;
    }
    return browser;
  }

  async function ensureContext(): Promise<BrowserContext> {
    if (browserContext) return browserContext;
    // Promise cache: concurrent callers share one context creation and all await the same result.
    if (!contextInitPromise) {
      contextInitPromise = (async (): Promise<BrowserContext> => {
        // intentional assignment: set promise cache once
        let ctx: BrowserContext;
        // Persistent context path: userDataDir bypasses ensureBrowser() entirely.
        // chromium.launchPersistentContext() returns a BrowserContext directly.
        if (config.userDataDir && !config.browser && !config.cdpEndpoint && !config.wsEndpoint) {
          const launchArgs = config.stealth
            ? [
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
              ]
            : [];
          ctx = await chromium.launchPersistentContext(config.userDataDir, {
            headless: config.headless ?? true,
            timeout: config.launchTimeout ?? LAUNCH_DEFAULT_MS,
            args: launchArgs,
            ...(config.stealth ? { ignoreDefaultArgs: ["--enable-automation"] } : {}),
          });
        } else {
          const b = await ensureBrowser();
          // For CDP/WS connections, reuse the default context if one exists —
          // but flag it as borrowed so we don't mutate or close caller state.
          if (config.cdpEndpoint || config.wsEndpoint) {
            const contexts = b.contexts();
            const existing = contexts[0];
            if (existing) {
              ctx = existing;
              borrowedContext = true;
            } else {
              ctx = await b.newContext();
            }
          } else {
            ctx = await b.newContext();
          }
        }
        // Inject stealth script at context level — covers all pages and window.open() tabs.
        // Skipped for external-transport paths (caller owns stealth policy for their browser).
        if (config.stealth && !config.browser && !config.cdpEndpoint && !config.wsEndpoint) {
          await ctx.addInitScript(STEALTH_INIT_SCRIPT);
        }

        // DNS rebinding guard — re-resolve hostnames at request time for document navigations.
        // Catches post-TTL rebinding that bypasses the static URL check in url-security.ts.
        // Default: enabled (blockPrivateAddresses !== false).
        // Skipped on borrowed contexts: we must not install route handlers on a context
        // that the caller also drives. The tool-layer url-security check still applies
        // to navigations issued by Koi's own `navigate` tool calls.
        if (config.blockPrivateAddresses !== false && !borrowedContext) {
          await ctx.route("**", async (route) => {
            const req = route.request();
            // Only intercept main-frame document navigations — sub-resources are not rebinding vectors
            if (req.resourceType() !== "document" || !req.isNavigationRequest()) {
              await route.continue();
              return;
            }
            try {
              const url = new URL(req.url());
              // Default-deny non-HTTP(S) schemes on page-driven navigations
              // (file://, data://, chrome://, chrome-extension://, etc.).
              // `about:` remains allowed for internal cleanup parking.
              if (url.protocol !== "http:" && url.protocol !== "https:") {
                if (url.protocol === "about:") {
                  await route.continue();
                  return;
                }
                await route.abort("accessdenied");
                return;
              }
              const host = url.hostname;
              const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
              // IP literal — block directly without DNS (covers page-initiated
              // navigations like window.open("http://127.0.0.1/") that bypass
              // the tool-layer URL check).
              const isIpLiteral =
                /^\d+(\.\d+){3}$/.test(bare) ||
                (bare.includes(":") && /^[\da-fA-F:.]+$/.test(bare));
              if (isIpLiteral) {
                if (isPrivateIp(bare)) {
                  await route.abort("accessdenied");
                  return;
                }
                await route.continue();
                return;
              }
              // Explicit localhost (OS-dependent DNS rules).
              if (bare === "localhost" || bare.endsWith(".localhost")) {
                await route.abort("accessdenied");
                return;
              }
              // Enumerate all addresses — hostnames with mixed public/private
              // records must be denied regardless of which single record Node
              // returns first.
              const addresses = await dnsPromises.lookup(bare, {
                all: true,
                verbatim: true,
              });
              for (const { address } of addresses) {
                if (isPrivateIp(address)) {
                  await route.abort("accessdenied");
                  return;
                }
              }
            } catch {
              // DNS lookup failure → fail closed (deny the request)
              await route.abort("accessdenied");
              return;
            }
            await route.continue();
          });
        }

        return ctx;
      })();
    }
    try {
      browserContext = await contextInitPromise; // intentional assignment: cache resolved context for sync access
    } catch (e: unknown) {
      contextInitPromise = null; // intentional reset: allow retry on next call instead of caching rejection forever
      throw e;
    }
    return browserContext;
  }

  async function ensurePage(): Promise<Page> {
    if (currentTabId === null) {
      const ctx = await ensureContext();
      const page = await ctx.newPage();
      await installPageRebindingGuard(page, config.blockPrivateAddresses !== false);
      const tabId = newTabId();
      tabs.set(tabId, page);
      currentTabId = tabId;
      attachConsoleListener(page, tabId);
    }
    const page = tabs.get(currentTabId);
    if (!page) {
      throw new Error(`internal: currentTabId "${currentTabId}" has no page`);
    }
    return page;
  }

  function getActiveTabId(): string | null {
    return currentTabId;
  }

  /** Returns a STALE_REF error if snapshotId is provided but doesn't match the active tab's. */
  function checkSnapshotId(snapshotId: string | undefined): Result<void, KoiError> | null {
    if (snapshotId === undefined) return null;
    const tabId = getActiveTabId();
    if (!tabId) return null;
    const snap = tabSnapshots.get(tabId);
    if (!snap || snapshotId !== snap.snapshotId) {
      return {
        ok: false,
        error: staleRef(
          snapshotId,
          "call browser_snapshot to get fresh refs — the page changed since this snapshot was taken",
        ),
      };
    }
    return null;
  }

  /**
   * Resolve a ref to a Playwright Locator, optionally scoped inside an iframe.
   *
   * Priority:
   *   1. Native aria-ref → direct attribute selector (O(1))
   *   2. getByRole(role, {name}).nth(nthIndex) — with deduplication
   *
   * When frameSelector is provided, all resolution is done via page.frameLocator(),
   * which supports cross-origin iframes without explicit context switching.
   */
  function getLocator(page: Page, ref: string, frameSelector?: string): Locator | null {
    const tabId = getActiveTabId();
    if (!tabId) return null;
    const snap = tabSnapshots.get(tabId);
    if (!snap) return null;
    const refInfo = snap.refs[ref];
    if (!refInfo) return null;

    const root: Page | FrameLocator = frameSelector ? page.frameLocator(frameSelector) : page;

    // Strategy 1: native aria-ref direct attribute lookup
    if (refInfo.ariaRef) {
      return root.locator(`[aria-ref="${refInfo.ariaRef}"]`);
    }

    // Strategy 2: getByRole with nth deduplication
    if (!isAriaRole(refInfo.role)) return null;
    const role = refInfo.role; // narrowed to AriaRole by isAriaRole guard above
    const nthIndex = refInfo.nthIndex ?? 0;
    if (refInfo.name) {
      return root.getByRole(role, { name: refInfo.name, exact: true }).nth(nthIndex);
    }
    return root.getByRole(role).nth(nthIndex);
  }

  /** Get a Locator or return a STALE_REF/NOT_FOUND error Result. */
  function requireLocator(
    page: Page,
    ref: string,
    frameSelector?: string,
  ): { readonly locator: Locator } | { readonly error: Result<never, KoiError> } {
    const locator = getLocator(page, ref, frameSelector);
    if (!locator) {
      return {
        error: {
          ok: false,
          error: staleRef(
            ref,
            "call browser_snapshot to refresh refs — this ref is not in the current snapshot",
          ),
        },
      };
    }
    return { locator };
  }

  // ---------------------------------------------------------------------------
  // BrowserDriver implementation
  // ---------------------------------------------------------------------------

  return {
    name: "playwright",

    async snapshot(
      options?: BrowserSnapshotOptions,
    ): Promise<Result<BrowserSnapshotResult, KoiError>> {
      try {
        const page = await ensurePage();
        const tabId = currentTabId;
        if (!tabId) return { ok: false, error: internal("No active tab") };

        const locator = options?.selector
          ? page.locator(options.selector).first()
          : page.locator("body");
        const yamlText = await locator.ariaSnapshot();

        if (!yamlText) {
          return {
            ok: false,
            error: internal("Accessibility snapshot returned empty — page may not be fully loaded"),
          };
        }

        const { text, refs, truncated, title: yamlTitle } = parseAriaYaml(yamlText, options);

        // Generate a new snapshotId and store per-tab state
        const prevCounter = tabSnapshots.get(tabId)?.refCounter ?? 0;
        const refCounter = prevCounter + 1;
        const snapshotId = `snap-${tabId}-${refCounter}`;
        tabSnapshots.set(tabId, {
          snapshotId,
          refs,
          refCounter,
        });

        // Use title from YAML if extracted, fall back to IPC only when absent
        const title = yamlTitle ?? (await page.title());

        return {
          ok: true,
          value: {
            snapshot: text,
            snapshotId,
            refs,
            truncated,
            url: page.url(),
            title,
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_snapshot", e) };
      }
    },

    async navigate(
      url: string,
      options?: BrowserNavigateOptions,
    ): Promise<Result<BrowserNavigateResult, KoiError>> {
      try {
        // Driver-level private-address gate — runs BEFORE page.goto, regardless
        // of context ownership. Borrowed contexts (cdpEndpoint/wsEndpoint paths
        // where we reused the caller's default context) cannot have the route()
        // guard installed; this check covers them.
        const blockPrivate = config.blockPrivateAddresses !== false;
        const guardErr = await checkNavigationUrlAllowed(url, blockPrivate);
        if (guardErr) return { ok: false, error: guardErr };

        const page = await ensurePage();
        const tabId = currentTabId;
        if (!tabId) return { ok: false, error: internal("No active tab") };

        const t = resolveTimeout(
          options?.timeout,
          NAVIGATE_DEFAULT_MS,
          NAVIGATE_MAX_MS,
          "navigate",
        );
        if (!t.ok) return t;

        invalidateTabSnapshot(tabId);

        await page.goto(url, {
          waitUntil: options?.waitUntil ?? "load",
          timeout: t.value,
        });

        // Post-navigation redirect check — covers server-side 30x redirects
        // to private addresses on borrowed contexts (where ctx.route() was
        // skipped). On owned contexts this is defense-in-depth since
        // ctx.route() already aborted the redirect request.
        const finalUrlErr = await checkNavigationUrlAllowed(page.url(), blockPrivate);
        if (finalUrlErr) {
          // Park the page at about:blank so the private-address response is
          // no longer reachable, then report the error.
          await page.goto("about:blank", { timeout: 1000 }).catch(() => undefined);
          return { ok: false, error: finalUrlErr };
        }

        return {
          ok: true,
          value: {
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_navigate", e) };
      }
    },

    async click(ref: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "click");
        if (!t.ok) return t;

        await found.locator.click({ timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_click", e) };
      }
    },

    async hover(ref: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "hover");
        if (!t.ok) return t;

        await found.locator.hover({ timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_hover", e) };
      }
    },

    async press(key: string, options?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "press");
        if (!t.ok) return t;

        await page.keyboard.press(key);
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_press", e) };
      }
    },

    async type(
      ref: string,
      value: string,
      options?: BrowserTypeOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "type");
        if (!t.ok) return t;

        if (options?.clear) {
          await found.locator.clear({ timeout: t.value });
        }
        await found.locator.fill(value, { timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_type", e) };
      }
    },

    async select(
      ref: string,
      value: string,
      options?: BrowserActionOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "select");
        if (!t.ok) return t;

        await found.locator.selectOption(value, { timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_select", e) };
      }
    },

    async fillForm(
      fields: readonly BrowserFormField[],
      options?: BrowserActionOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "fill_form");
        if (!t.ok) return t;

        // Pass 1: validate all refs before touching any field (atomic guarantee)
        const resolved: Array<{ readonly locator: Locator; readonly field: BrowserFormField }> = [];
        for (const field of fields) {
          const found = requireLocator(page, field.ref, options?.frameSelector);
          if ("error" in found) return found.error;
          resolved.push({ locator: found.locator, field });
        }

        // Pass 2: fill — parallel when caller opts in, sequential otherwise
        if (options?.parallel) {
          await Promise.all(
            resolved.map(async ({ locator, field }) => {
              if (field.clear) await locator.clear({ timeout: t.value });
              await locator.fill(field.value, { timeout: t.value });
            }),
          );
        } else {
          for (const { locator, field } of resolved) {
            if (field.clear) await locator.clear({ timeout: t.value });
            await locator.fill(field.value, { timeout: t.value });
          }
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_fill_form", e) };
      }
    },

    async scroll(options: BrowserScrollOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();

        if (options.kind === "element") {
          const stale = checkSnapshotId(options.snapshotId);
          if (stale) return stale;

          const found = requireLocator(page, options.ref);
          if ("error" in found) return found.error;

          const t = resolveTimeout(options.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "scroll");
          if (!t.ok) return t;

          await found.locator.scrollIntoViewIfNeeded({ timeout: t.value });
        } else {
          const directionMap: Readonly<Record<string, readonly [number, number]>> = {
            up: [0, -1],
            down: [0, 1],
            left: [-1, 0],
            right: [1, 0],
          };
          const dir = directionMap[options.direction] ?? ([0, 1] as const);
          const amount = options.amount ?? 400;
          await page.mouse.wheel(dir[0] * amount, dir[1] * amount);
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_scroll", e) };
      }
    },

    async screenshot(
      options?: BrowserScreenshotOptions,
    ): Promise<Result<BrowserScreenshotResult, KoiError>> {
      try {
        const page = await ensurePage();
        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "screenshot");
        if (!t.ok) return t;

        const quality = options?.quality ?? 80;
        const fullPage = options?.fullPage ?? false;

        const buffer = await page.screenshot({
          fullPage,
          type: quality < 100 ? "jpeg" : "png",
          ...(quality < 100 ? { quality } : {}),
          timeout: t.value,
        });

        const mimeType = quality < 100 ? "image/jpeg" : "image/png";
        const viewportSize = page.viewportSize();
        const width = viewportSize?.width ?? 1280;
        const height = viewportSize?.height ?? 720;

        return {
          ok: true,
          value: {
            data: buffer.toString("base64"),
            mimeType,
            width,
            height,
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_screenshot", e) };
      }
    },

    async wait(options: BrowserWaitOptions): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();

        if (options.kind === "timeout") {
          const t = resolveTimeout(options.timeout, WAIT_DEFAULT_MS, WAIT_MAX_MS, "wait");
          if (!t.ok) return t;
          await page.waitForTimeout(t.value);
        } else if (options.kind === "selector") {
          const t = resolveTimeout(options.timeout, WAIT_DEFAULT_MS, WAIT_MAX_MS, "wait");
          if (!t.ok) return t;
          await page.waitForSelector(options.selector, {
            state: options.state ?? "visible",
            timeout: t.value,
          });
        } else {
          const t = resolveTimeout(options.timeout, WAIT_DEFAULT_MS, WAIT_MAX_MS, "wait");
          if (!t.ok) return t;
          await page.waitForNavigation({
            waitUntil: options.event ?? "load",
            timeout: t.value,
          });
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_wait", e) };
      }
    },

    async tabNew(options?: BrowserTabNewOptions): Promise<Result<BrowserTabInfo, KoiError>> {
      try {
        // Driver-level private-address gate for the tabNew-with-url path.
        if (options?.url) {
          const guardErr = await checkNavigationUrlAllowed(
            options.url,
            config.blockPrivateAddresses !== false,
          );
          if (guardErr) return { ok: false, error: guardErr };
        }

        const ctx = await ensureContext();
        const page = await ctx.newPage();
        await installPageRebindingGuard(page, config.blockPrivateAddresses !== false);
        const tabId = newTabId();
        tabs.set(tabId, page);
        attachConsoleListener(page, tabId);
        const previousTabId = currentTabId;

        if (options?.url) {
          const t = resolveTimeout(
            options.timeout,
            NAVIGATE_DEFAULT_MS,
            NAVIGATE_MAX_MS,
            "tab_new",
          );
          if (!t.ok) {
            await page.close();
            tabs.delete(tabId);
            tabConsoleLogs.delete(tabId);
            return t;
          }
          try {
            await page.goto(options.url, { timeout: t.value });
          } catch (gotoErr: unknown) {
            // Navigation failed — clean up the new page and restore previous tab focus
            await page.close().catch(() => undefined);
            tabs.delete(tabId);
            tabConsoleLogs.delete(tabId);
            currentTabId = previousTabId; // intentional restore: goto() failed, revert to previous tab
            throw gotoErr;
          }
          // Post-navigation redirect check — defense-in-depth against public
          // URLs that redirect to private addresses. The per-page route guard
          // aborts these at request time for owned transports, but we still
          // validate the final URL as a safety net.
          const finalErr = await checkNavigationUrlAllowed(
            page.url(),
            config.blockPrivateAddresses !== false,
          );
          if (finalErr) {
            await page.close().catch(() => undefined);
            tabs.delete(tabId);
            tabConsoleLogs.delete(tabId);
            currentTabId = previousTabId;
            return { ok: false, error: finalErr };
          }
        }

        // New tab becomes the active tab only after successful navigation (or no URL requested).
        currentTabId = tabId;

        return {
          ok: true,
          value: {
            tabId,
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_new", e) };
      }
    },

    async tabClose(
      tabId?: string,
      _options?: BrowserTabCloseOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const targetId = tabId ?? currentTabId;
        if (!targetId) {
          return { ok: false, error: notFound("No tab to close") };
        }
        const page = tabs.get(targetId);
        if (!page) {
          return { ok: false, error: notFound(`Tab "${targetId}" not found`) };
        }
        await page.close();
        tabs.delete(targetId);
        invalidateTabSnapshot(targetId);
        tabConsoleLogs.delete(targetId);

        if (currentTabId === targetId) {
          // Single-pass iterator — avoids allocating a full array just to get the last key.
          let lastKey: string | null = null;
          for (const k of tabs.keys()) lastKey = k;
          currentTabId = lastKey;
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_close", e) };
      }
    },

    async tabFocus(
      tabId: string,
      _options?: BrowserTabFocusOptions,
    ): Promise<Result<BrowserTabInfo, KoiError>> {
      try {
        const page = tabs.get(tabId);
        if (!page) {
          return { ok: false, error: notFound(`Tab "${tabId}" not found`) };
        }
        // bringToFront() has no built-in timeout; guard against infinite hangs.
        // Timer handle is cleared on normal resolution to avoid dangling rejections.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("bringToFront timed out")), 10_000);
          page.bringToFront().then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (e: unknown) => {
              clearTimeout(timer);
              reject(e);
            },
          );
        });
        currentTabId = tabId;
        // Note: we do NOT invalidate the tab's snapshot — per-tab caching preserves it

        return {
          ok: true,
          value: {
            tabId,
            url: page.url(),
            title: await page.title(),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_focus", e) };
      }
    },

    async tabList(): Promise<Result<readonly BrowserTabInfo[], KoiError>> {
      try {
        // Fire all CDP title() calls in parallel — one round-trip per tab concurrently.
        const entries = [...tabs.entries()];
        const value = await Promise.all(
          entries.map(async ([tabId, page]) => ({
            tabId,
            url: page.url(),
            title: await page.title(),
          })),
        );
        return { ok: true, value };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_tab_list", e) };
      }
    },

    async console(
      options?: BrowserConsoleOptions,
    ): Promise<Result<BrowserConsoleResult, KoiError>> {
      const buf = currentTabId !== null ? (tabConsoleLogs.get(currentTabId) ?? []) : [];
      const MAX_LIMIT = 200;
      const limit = Math.min(options?.limit ?? 50, MAX_LIMIT);
      const levels = options?.levels;
      const filtered = levels ? buf.filter((e) => levels.includes(e.level)) : buf;
      const total = filtered.length;
      const entries = filtered.slice(-limit);
      if (options?.clear === true && currentTabId !== null) {
        tabConsoleLogs.set(currentTabId, []);
      }
      return { ok: true, value: { entries, total } };
    },

    async evaluate(
      script: string,
      options?: BrowserEvaluateOptions,
    ): Promise<Result<BrowserEvaluateResult, KoiError>> {
      try {
        const page = await ensurePage();
        const tabId = currentTabId;
        const t = resolveTimeout(
          options?.timeout,
          EVALUATE_DEFAULT_MS,
          EVALUATE_MAX_MS,
          "evaluate",
        );
        if (!t.ok) return t;

        // page.evaluate() has no native timeout and no cancellation primitive.
        // A Promise.race timeout leaves the page-side script running — side
        // effects from the script can continue after the driver returns an
        // error (double-submits, leaked mutations, inconsistent retries).
        //
        // On timeout, we INVALIDATE THE JS EXECUTION CONTEXT by navigating
        // the page to about:blank. That forcibly terminates whatever the
        // script was doing and surfaces `STALE_REF` / fresh-snapshot semantics
        // to the caller via the existing invalidation path.
        let timedOut = false;
        const value: unknown = await Promise.race([
          page.evaluate(script),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              timedOut = true;
              reject(new Error(`evaluate timed out after ${t.value}ms`));
            }, t.value);
          }),
        ]).catch(async (err: unknown) => {
          if (timedOut) {
            // Kill the execution context so the still-running script cannot
            // mutate state after we return an error. Escalate in steps:
            //   1. goto about:blank — cleanest; keeps the tab usable. KEEP in map.
            //   2. page.close() if (1) fails — tab is gone. DROP from map.
            //   3. If both fail — renderer wedged. DROP from map anyway so the
            //      caller gets a fresh page on next ensurePage().
            let cleanup: "navigated" | "closed" | "abandoned" = "abandoned";
            try {
              await page.goto("about:blank", { timeout: 1000 });
              cleanup = "navigated";
            } catch {
              // goto failed — escalate.
            }
            if (cleanup === "abandoned") {
              try {
                await page.close({ runBeforeUnload: false });
                cleanup = "closed";
              } catch {
                // page.close() also failed — remains "abandoned".
              }
            }
            if (tabId) {
              // Snapshot is stale no matter what — script may have mutated state.
              invalidateTabSnapshot(tabId);
              // Only drop from tabs map when the page is actually gone or abandoned.
              // If goto succeeded, the page is alive at about:blank and should
              // remain managed so dispose() / tabList() / tabClose() can find it.
              if (cleanup !== "navigated") {
                tabs.delete(tabId);
                tabConsoleLogs.delete(tabId);
                // When there are NO other tabs, null currentTabId so the next
                // ensurePage() creates a fresh one (only path where that's safe).
                // When other tabs exist, keep currentTabId pointing at the
                // now-missing id — ensurePage() will throw a clear "no active
                // tab" internal error, forcing the caller to explicitly tabFocus
                // before continuing. This avoids two hazards:
                //   (a) silent retarget to a surviving tab the caller didn't
                //       choose (could cause writes/reads against the wrong page);
                //   (b) silent new-blank-tab creation that orphans the rest of
                //       the session.
                if (currentTabId === tabId && tabs.size === 0) {
                  currentTabId = null;
                }
              }
            }
          }
          throw err;
        });
        return { ok: true, value: { value } };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_evaluate", e) };
      }
    },

    async upload(
      ref: string,
      files: readonly BrowserUploadFile[],
      options?: BrowserUploadOptions,
    ): Promise<Result<void, KoiError>> {
      try {
        const page = await ensurePage();
        const stale = checkSnapshotId(options?.snapshotId);
        if (stale) return stale;

        const found = requireLocator(page, ref, options?.frameSelector);
        if ("error" in found) return found.error;

        const t = resolveTimeout(options?.timeout, ACTION_DEFAULT_MS, ACTION_MAX_MS, "upload");
        if (!t.ok) return t;

        // Convert base64 content to Buffer payloads for Playwright setInputFiles
        const payloads = files.map((f) => ({
          name: f.name,
          mimeType: f.mimeType ?? "application/octet-stream",
          buffer: Buffer.from(f.content, "base64"),
        }));

        await found.locator.setInputFiles(payloads, { timeout: t.value });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_upload", e) };
      }
    },

    async traceStart(options?: BrowserTraceOptions): Promise<Result<void, KoiError>> {
      try {
        const ctx = await ensureContext();
        // Refuse on borrowed contexts — tracing captures every tab/page in the
        // context, including ones the caller owns. Would exfiltrate unrelated
        // browsing data when the driver is attached via cdpEndpoint/wsEndpoint
        // to a live browser session.
        if (borrowedContext) {
          return {
            ok: false,
            error: permission(
              "browser_trace_start refused on borrowed-context transports (cdpEndpoint/wsEndpoint). Tracing would capture caller-owned tabs. Use a driver-owned browser (launch mode) if tracing is needed.",
            ),
          };
        }
        await ctx.tracing.start({
          snapshots: options?.snapshots ?? true,
          screenshots: true,
          sources: false,
          ...(options?.title !== undefined ? { title: options.title } : {}),
        });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_trace_start", e) };
      }
    },

    async traceStop(): Promise<Result<BrowserTraceResult, KoiError>> {
      try {
        const ctx = await ensureContext();
        if (borrowedContext) {
          return {
            ok: false,
            error: permission(
              "browser_trace_stop refused on borrowed-context transports. Tracing was never allowed to start on this transport.",
            ),
          };
        }
        const tracePath = join(tmpdir(), `koi-trace-${Date.now()}.zip`);
        await ctx.tracing.stop({ path: tracePath });
        return { ok: true, value: { path: tracePath } };
      } catch (e: unknown) {
        return { ok: false, error: translatePlaywrightError("browser_trace_stop", e) };
      }
    },

    async dispose(): Promise<void> {
      // Invalidate all tab snapshots and console buffers
      tabSnapshots.clear();
      tabConsoleLogs.clear();

      for (const page of tabs.values()) {
        await page.close().catch(() => undefined);
      }
      tabs.clear();
      currentTabId = null;

      if (browserContext) {
        // Only close the context if we created it ourselves. Borrowed contexts
        // (reused from an external browser on cdpEndpoint/wsEndpoint paths)
        // belong to the caller — closing them would take down their pages.
        if (!borrowedContext) {
          await browserContext.close().catch(() => undefined);
        }
        browserContext = null;
        borrowedContext = false;
        contextInitPromise = null; // intentional mutation: reset so a new driver can be re-initialized after dispose
      }

      // Only close browser if we launched it (not injected and not CDP)
      if (ownsLifecycle && browser) {
        await browser.close().catch(() => undefined);
        browser = null;
        browserInitPromise = null; // intentional mutation: reset so a new driver can be re-initialized after dispose
      }
    },
  };
}

// Re-export for consumers who want to use VALID_ROLES or isAriaRole directly
export { isAriaRole, VALID_ROLES };
