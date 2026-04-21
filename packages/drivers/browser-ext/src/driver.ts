import { randomBytes, randomUUID } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import type {
  BrowserActionOptions,
  BrowserConsoleOptions,
  BrowserConsoleResult,
  BrowserDriver,
  BrowserEvaluateOptions,
  BrowserEvaluateResult,
  BrowserFormField,
  BrowserNavigateOptions,
  BrowserNavigateResult,
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
import type { HostSelector } from "./discovery-client.js";
import { selectDiscoveryHost } from "./discovery-client.js";
import { createExtensionError } from "./errors.js";
import { createReconnectController } from "./reconnect.js";
import {
  createDriverClient,
  createLoopbackWebSocketBridge,
  type LoopbackWebSocketBridge,
} from "./unix-socket-transport.js";

export type ReattachPolicy = "consent_required_if_missing" | "prompt_if_missing";

export interface ExtensionDriverConfig {
  readonly instancesDir?: string | undefined;
  /**
   * Directory containing the `token` file. Must belong to the same
   * installation as `instancesDir` — otherwise the driver would discover one
   * host and authenticate against a different install's token. Defaults to
   * `~/.koi/browser-ext/`. If you override `instancesDir`, pass `authDir` too
   * (or supply `authToken` directly) so both sides agree on install root.
   */
  readonly authDir?: string | undefined;
  readonly authToken?: string | undefined;
  readonly select?: HostSelector | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly reattachPolicy?: ReattachPolicy | undefined;
  readonly onReattach?:
    | ((context: { readonly tabId: number; readonly origin: string }) => ReattachPolicy)
    | undefined;
  readonly connectSocketFactory?: ((socket: string) => Socket | Duplex) | undefined;
  /**
   * Lazy factory callback the extension driver invokes on first interaction
   * to produce a Playwright-backed delegate.
   *
   * **Caller MUST select the target tab explicitly** via
   * `selectTargetTab(tabId, origin)` on the returned driver before any
   * interaction method (snapshot/navigate/click/…). Auto-picking a tab is
   * intentionally NOT supported — it risks mutating the wrong live page.
   *
   * Flow when configured:
   *   1. `selectTargetTab(tabId, origin)` — user picks the tab.
   *   2. First interaction method call → driver calls `attachLoopbackBridge`
   *      on the selected tab, stands up a loopback WS bridge, invokes this
   *      factory with `{ wsEndpoint, wsHeaders }`.
   *   3. All subsequent interactions forward to the cached delegate.
   *
   * The factory is called exactly once per extension-driver lifetime. Its
   * returned driver is disposed on `driver.dispose()`.
   *
   * Type-only reference to `BrowserDriver` keeps `@koi/browser-ext` free of
   * direct `@koi/browser-playwright` dep.
   */
  readonly createPlaywrightDriver?:
    | ((args: {
        readonly wsEndpoint: string;
        readonly wsHeaders: Readonly<Record<string, string>>;
      }) => BrowserDriver | Promise<BrowserDriver>)
    | undefined;
}

const DEFAULT_INSTANCES_DIR: string = join(homedir(), ".koi/browser-ext/instances");
const DEFAULT_AUTH_DIR: string = join(homedir(), ".koi/browser-ext");

interface RuntimeConnection {
  readonly socketPath: string;
  readonly client: ReturnType<typeof createDriverClient>;
  readonly leaseToken: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Minimal inline private-address check for tabNew() URL validation.
// Keeps in sync with the broader check in @koi/browser-playwright — we
// cannot import that package (L2→L2 violation), so duplicate the
// literal-IP coverage here. Hostnames are NOT resolved (no DNS) because
// tabNew is synchronous with respect to the host; DNS-based checks belong
// at the route/Fetch layer that Chromium drives.
function isRfc1918OrLoopback(ipOrHost: string): boolean {
  const lower = ipOrHost.toLowerCase();
  if (
    /^127\./.test(lower) ||
    /^10\./.test(lower) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(lower) ||
    /^192\.168\./.test(lower) ||
    /^169\.254\./.test(lower) ||
    lower === "0.0.0.0"
  ) {
    return true;
  }
  // IPv6 loopback / link-local / unique local / v4-mapped forms.
  if (
    lower === "::1" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  ) {
    return true;
  }
  const mapped = /^::ffff:([\d.]+)$/.exec(lower);
  if (mapped?.[1]) return isRfc1918OrLoopback(mapped[1]);
  return false;
}

async function readAuthToken(config: ExtensionDriverConfig): Promise<string> {
  if (config.authToken !== undefined) {
    return config.authToken;
  }
  const authDir = config.authDir ?? DEFAULT_AUTH_DIR;
  return (await readFile(join(authDir, "token"), "utf-8")).trim();
}

function createClientForSocket(
  socket: string,
  connectSocketFactory?: (socket: string) => Socket | Duplex,
): ReturnType<typeof createDriverClient> {
  if (connectSocketFactory !== undefined) {
    return createDriverClient({
      connectSocket: () => connectSocketFactory(socket),
    });
  }
  if (socket.startsWith("tcp://")) {
    const endpoint = new URL(socket);
    const port = Number(endpoint.port);
    const host = endpoint.hostname;
    return createDriverClient({
      connectSocket: () =>
        createConnection({
          port,
          host,
        }),
    });
  }
  return createDriverClient(socket);
}

function missingPlaywrightError<T>(operation: string): Result<T, KoiError> {
  return {
    ok: false,
    error: createExtensionError(
      "HOST_SPAWN_FAILED",
      `${operation}: no createPlaywrightDriver factory was supplied to createExtensionBrowserDriver. ` +
        "Configure createPlaywrightDriver and call selectTargetTab(tabId, origin) before interacting.",
      { operation },
    ),
  };
}

class ExtensionBrowserDriverRuntime {
  private readonly config: ExtensionDriverConfig;
  private readonly reconnectController: ReturnType<typeof createReconnectController>;
  private connectionPromise: Promise<RuntimeConnection> | null = null;
  private activeConnection: RuntimeConnection | null = null;
  private disposed = false;
  private readonly transportLostListeners: Array<() => void> = [];

  public onTransportLostSignal(listener: () => void): void {
    this.transportLostListeners.push(listener);
  }

  public constructor(config: ExtensionDriverConfig) {
    this.config = config;
    this.reconnectController = createReconnectController({
      attempt: async (): Promise<boolean> => {
        try {
          await this.connectFresh();
          return true;
        } catch {
          return false;
        }
      },
      sleep,
    });
  }

  public async dispose(): Promise<void> {
    // Mark disposed FIRST so any in-flight onTransportLost callback becomes a
    // no-op instead of kicking the reconnect loop after intentional shutdown.
    this.disposed = true;
    const connection = this.activeConnection;
    this.activeConnection = null;
    this.connectionPromise = null;
    // Clear the socket-close handler on the underlying client too so the
    // driver-level close firing after dispose cannot re-arm reconnect.
    connection?.client.setCloseHandler(null);
    await connection?.client.close();
  }

  public async getTransport(): Promise<ReturnType<typeof createDriverClient>> {
    const conn = await this.ensureConnection();
    return conn.client;
  }

  private onTransportLost(): void {
    this.activeConnection = null;
    this.connectionPromise = null;
    for (const listener of this.transportLostListeners) {
      try {
        listener();
      } catch {
        // Listener errors shouldn't abort transport-loss handling.
      }
    }
    if (this.disposed) return;
    void this.reconnectController.run();
  }

  private async connectFresh(): Promise<RuntimeConnection> {
    const instancesDir = this.config.instancesDir ?? DEFAULT_INSTANCES_DIR;
    const selected = await selectDiscoveryHost({
      instancesDir,
      select: this.config.select,
    });
    if ("code" in selected) {
      throw selected;
    }
    const token = await readAuthToken(this.config);
    const client = createClientForSocket(selected.socket, this.config.connectSocketFactory);
    await client.connect();
    client.setCloseHandler((): void => {
      this.onTransportLost();
    });

    const leaseToken = randomBytes(16).toString("hex");
    const driverSupportedProtocols = [1];
    const hello = await client.hello({
      kind: "hello",
      token,
      driverVersion: "0.0.0",
      supportedProtocols: driverSupportedProtocols,
      leaseToken,
    });

    if (hello.ok !== true) {
      await client.close();
      throw createExtensionError(
        "HOST_SPAWN_FAILED",
        `Browser extension host handshake failed: ${hello.reason}`,
        { reason: hello.reason },
      );
    }

    // Verify the host's selectedProtocol is one we actually advertised.
    // Prevents silent protocol skew: the host should never pick a version
    // we didn't offer.
    if (!driverSupportedProtocols.includes(hello.selectedProtocol)) {
      await client.close();
      throw createExtensionError(
        "HOST_SPAWN_FAILED",
        `Browser extension host selected unsupported protocol ${hello.selectedProtocol}; driver advertised ${JSON.stringify(driverSupportedProtocols)}`,
        { selectedProtocol: hello.selectedProtocol },
      );
    }

    const connection: RuntimeConnection = {
      socketPath: selected.socket,
      client,
      leaseToken,
    };
    this.activeConnection = connection;
    return connection;
  }

  public async ensureConnection(): Promise<RuntimeConnection> {
    if (this.activeConnection !== null) {
      return this.activeConnection;
    }
    if (this.connectionPromise === null) {
      this.connectionPromise = this.connectFresh().finally(() => {
        if (this.activeConnection === null) {
          this.connectionPromise = null;
        }
      });
    }
    return this.connectionPromise;
  }

  public async tabList(): Promise<Result<readonly BrowserTabInfo[], KoiError>> {
    try {
      const connection = await this.ensureConnection();
      const tabs = await connection.client.listTabs();
      return {
        ok: true,
        value: tabs.tabs.map((tab) => ({
          tabId: String(tab.id),
          url: tab.url,
          title: tab.title,
        })),
      };
    } catch (error) {
      return {
        ok: false,
        error: isKoiError(error)
          ? error
          : createExtensionError(
              "HOST_SPAWN_FAILED",
              "Failed to list tabs from the browser extension host.",
              undefined,
              error,
            ),
      };
    }
  }

  public async openTab(url?: string): Promise<Result<BrowserTabInfo, KoiError>> {
    try {
      const connection = await this.ensureConnection();
      const ack = await connection.client.openTab(url);
      if (!ack.ok || !ack.tab) {
        return {
          ok: false,
          error: createExtensionError(
            "HOST_SPAWN_FAILED",
            `chrome.tabs.create failed: ${ack.error ?? "unknown"}`,
            { url: url ?? null },
          ),
        };
      }
      return {
        ok: true,
        value: {
          tabId: String(ack.tab.id),
          url: ack.tab.url,
          title: ack.tab.title,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: isKoiError(error)
          ? error
          : createExtensionError(
              "HOST_SPAWN_FAILED",
              "Failed to open tab via the browser extension host.",
              undefined,
              error,
            ),
      };
    }
  }

  public async closeTab(tabId: number): Promise<Result<void, KoiError>> {
    try {
      const connection = await this.ensureConnection();
      const ack = await connection.client.closeTab(tabId);
      if (!ack.ok) {
        return {
          ok: false,
          error: createExtensionError(
            "HOST_SPAWN_FAILED",
            `chrome.tabs.remove failed: ${ack.error ?? "unknown"}`,
            { tabId },
          ),
        };
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: isKoiError(error)
          ? error
          : createExtensionError(
              "HOST_SPAWN_FAILED",
              "Failed to close tab via the browser extension host.",
              undefined,
              error,
            ),
      };
    }
  }

  public async attachLoopbackBridge(
    tabId: number,
    origin: string,
  ): Promise<Result<string, KoiError>> {
    try {
      const connection = await this.ensureConnection();
      const reattach =
        this.config.onReattach?.({ tabId, origin }) ??
        this.config.reattachPolicy ??
        "consent_required_if_missing";
      const attached = await connection.client.attach({
        kind: "attach",
        tabId,
        leaseToken: connection.leaseToken,
        attachRequestId: randomUUID(),
        reattach,
      });
      if (attached.ok !== true) {
        if (attached.reason === "consent_required") {
          return {
            ok: false,
            error: createExtensionError(
              "REATTACH_REQUIRES_CONSENT",
              "Tab requires re-consent after extension restart.",
              { tabId, origin },
            ),
          };
        }
        return {
          ok: false,
          error: createExtensionError(
            "EXT_USER_DENIED",
            `Browser extension attach failed: ${attached.reason}`,
            { reason: attached.reason, tabId },
          ),
        };
      }
      return { ok: true, value: attached.sessionId };
    } catch (error) {
      return {
        ok: false,
        error: isKoiError(error)
          ? error
          : createExtensionError(
              "TRANSPORT_LOST_GIVE_UP",
              "Failed to attach to the browser extension session.",
              undefined,
              error,
            ),
      };
    }
  }
}

function isKoiError(error: unknown): error is KoiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  );
}

/**
 * Extension driver augmented with the tab-attach primitive. Composing a
 * fully-featured browser driver on top of this is a caller responsibility —
 * typically done at L3 (runtime) with `@koi/browser-playwright`'s
 * `createPlaywrightBrowserDriver`. See `composeExtensionBrowserDriver`.
 */
export interface ExtensionBrowserDriver extends BrowserDriver {
  /**
   * Attach to a tab via the native host; returns the `sessionId` of the new
   * debugger session. Use this session id with `createLoopbackWebSocketBridge`
   * (exported separately) to stand up a CDP WebSocket endpoint that Playwright
   * can `connectOverCDP(wsEndpoint, { headers: wsHeaders })` against.
   */
  readonly attachLoopbackBridge: (
    tabId: number,
    origin: string,
  ) => Promise<Result<string, KoiError>>;
  /**
   * Explicitly select the tab the auto-composed Playwright delegate will
   * attach to. MUST be called before any interaction method when
   * `createPlaywrightDriver` is configured — no implicit "first tab" fallback.
   */
  readonly selectTargetTab: (tabId: number, origin: string) => void;
}

/**
 * **IMPORTANT — this is a PARTIAL BrowserDriver when `createPlaywrightDriver`
 * is not supplied.**
 *
 * Without a `createPlaywrightDriver` factory in `options`, every interaction
 * method (snapshot, navigate, click, type, evaluate, etc.) returns a clear
 * error — only `tabList()` and `attachLoopbackBridge()` work. This is by
 * design: `@koi/browser-ext` (L2) must not depend directly on
 * `@koi/browser-playwright` (also L2) — that would violate the layer
 * architecture. Composition is therefore a CALLER RESPONSIBILITY, ideally
 * done at L3 (runtime).
 *
 * When `createPlaywrightDriver` is supplied, the driver owns the delegate's
 * lifecycle: it is created lazily on first interaction (after
 * `selectTargetTab`), bound to the extension-owned loopback bridge for the
 * selected tab, and disposed when the bridge is invalidated. There is NO
 * caller-supplied pre-built delegate path — that would allow a delegate
 * bound to an unrelated browser to receive clicks/navigations while the
 * native host enumerates the user's live Chrome tabs, which is a real
 * cross-session-mutation hazard.
 *
 * Returns an `ExtensionBrowserDriver` (augmented `BrowserDriver` +
 * `attachLoopbackBridge`).
 */
export function createExtensionBrowserDriver(
  options: ExtensionDriverConfig = {},
): ExtensionBrowserDriver {
  const runtime = new ExtensionBrowserDriverRuntime(options);

  let cachedDelegate: BrowserDriver | null = null;
  let cachedBridge: LoopbackWebSocketBridge | null = null;
  let ensurePromise: Promise<Result<BrowserDriver, KoiError>> | null = null;
  let selectedTarget: { tabId: number; origin: string } | null = null;
  // Monotonic generation: bump on every invalidation (target change /
  // transport loss). In-flight delegate-creation captures its generation
  // at start; if the generation advances before completion, the stale
  // completion is discarded instead of overwriting the cache for a different
  // target.
  let delegateGeneration = 0;
  // Promise for the most recent bridge teardown. ensureDelegate() awaits
  // this before attaching a new bridge so back-to-back tabFocus/selectTab
  // calls can't race the old session's detach — otherwise the host (which
  // enforces single attached ownership) bounces the new attach as
  // `already_attached` while the old detach is still in flight.
  let pendingBridgeClose: Promise<void> = Promise.resolve();

  function invalidateDelegateCache(): void {
    const bridge = cachedBridge;
    const delegate = cachedDelegate;
    cachedBridge = null;
    cachedDelegate = null;
    ensurePromise = null;
    delegateGeneration += 1;
    if (bridge !== null) {
      pendingBridgeClose = pendingBridgeClose
        .catch(() => {})
        .then(() => bridge.close())
        .catch(() => {});
    }
    void delegate?.dispose?.();
  }

  // Tie delegate cache to transport lifecycle: a socket loss / reconnect on
  // the runtime side invalidates the bridge (it held a session on the old
  // DriverClient). Next interaction method re-runs the factory.
  runtime.onTransportLostSignal(() => {
    invalidateDelegateCache();
  });

  async function ensureDelegate(): Promise<Result<BrowserDriver, KoiError>> {
    if (cachedDelegate !== null) return { ok: true, value: cachedDelegate };
    if (!options.createPlaywrightDriver) {
      return {
        ok: false,
        error: createExtensionError(
          "HOST_SPAWN_FAILED",
          "No playwrightDriver or createPlaywrightDriver supplied to createExtensionBrowserDriver. " +
            "Configure one of them to enable interaction methods.",
        ),
      };
    }
    if (!selectedTarget) {
      return {
        ok: false,
        error: createExtensionError(
          "HOST_SPAWN_FAILED",
          "No target tab selected. Call driver.selectTargetTab(tabId, origin) before any " +
            "interaction method when createPlaywrightDriver is configured.",
        ),
      };
    }
    if (ensurePromise) return ensurePromise;

    const factory = options.createPlaywrightDriver;
    const target = selectedTarget;
    const myGeneration = delegateGeneration;

    function isStale(): boolean {
      return myGeneration !== delegateGeneration;
    }

    ensurePromise = (async (): Promise<Result<BrowserDriver, KoiError>> => {
      // Wait for any in-flight bridge teardown to fully release host-side
      // ownership before attaching a new bridge. Without this barrier the
      // host (single-attachment invariant) can reject the new attach as
      // `already_attached` while the previous session's detach_ack is still
      // pending.
      await pendingBridgeClose.catch(() => {});
      const sessionResult = await runtime.attachLoopbackBridge(target.tabId, target.origin);
      if (!sessionResult.ok) {
        if (!isStale()) ensurePromise = null;
        return sessionResult;
      }
      if (isStale()) {
        // Target changed while we were attaching — release the session we
        // acquired and surface a stale-retry error.
        try {
          const transport = await runtime.getTransport();
          await transport.detach(sessionResult.value);
        } catch {
          // swallow — cache already invalidated, caller will retry
        }
        return {
          ok: false,
          error: createExtensionError(
            "TRANSPORT_LOST_GIVE_UP",
            "Target changed during delegate creation; retry.",
          ),
        };
      }

      let bridge: LoopbackWebSocketBridge | null = null;
      let delegate: BrowserDriver | null = null;
      try {
        const token = randomBytes(16).toString("hex");
        const transport = await runtime.getTransport();
        bridge = await createLoopbackWebSocketBridge({
          token,
          sessionId: sessionResult.value,
          transport,
        });
        delegate = await factory({
          wsEndpoint: bridge.endpoint,
          wsHeaders: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        // Cleanup on failure: close the bridge (which sends detach to the host)
        // so the attached session is released. Otherwise the tab stays
        // debugger-attached and future attach attempts bounce with
        // already_attached.
        if (bridge) {
          await bridge.close().catch(() => {});
        } else {
          // Bridge creation itself failed (or didn't run); still detach the
          // session we just acquired so ownership clears.
          try {
            const transport = await runtime.getTransport();
            await transport.detach(sessionResult.value);
          } catch {
            // swallow — transport may itself be broken
          }
        }
        ensurePromise = null;
        return {
          ok: false,
          error: isKoiError(err)
            ? err
            : createExtensionError(
                "TRANSPORT_LOST_GIVE_UP",
                `Failed to compose Playwright delegate: ${(err as Error).message ?? String(err)}`,
                undefined,
                err,
              ),
        };
      }

      if (isStale()) {
        // Target changed between bridge creation and factory completion —
        // tear down what we built and refuse to populate the cache.
        await bridge.close().catch(() => {});
        try {
          await delegate.dispose?.();
        } catch {
          /* swallow */
        }
        return {
          ok: false,
          error: createExtensionError(
            "TRANSPORT_LOST_GIVE_UP",
            "Target changed during delegate creation; retry.",
          ),
        };
      }
      cachedDelegate = delegate;
      cachedBridge = bridge;
      return { ok: true, value: delegate };
    })();
    return ensurePromise;
  }

  async function delegateOrError<T>(
    _op: string,
    fn: (pw: BrowserDriver) => Result<T, KoiError> | Promise<Result<T, KoiError>>,
  ): Promise<Result<T, KoiError>> {
    const pwResult = await ensureDelegate();
    if (!pwResult.ok) return pwResult;
    return await fn(pwResult.value);
  }

  return {
    name: "browser-ext",
    snapshot(opts?: BrowserSnapshotOptions): Promise<Result<BrowserSnapshotResult, KoiError>> {
      return delegateOrError("snapshot", (pw) => pw.snapshot(opts));
    },
    navigate(
      url: string,
      opts?: BrowserNavigateOptions,
    ): Promise<Result<BrowserNavigateResult, KoiError>> {
      return delegateOrError("navigate", (pw) => pw.navigate(url, opts));
    },
    click(ref: string, opts?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("click", (pw) => pw.click(ref, opts));
    },
    type(ref: string, value: string, opts?: BrowserTypeOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("type", (pw) => pw.type(ref, value, opts));
    },
    select(
      ref: string,
      value: string,
      opts?: BrowserActionOptions,
    ): Promise<Result<void, KoiError>> {
      return delegateOrError("select", (pw) => pw.select(ref, value, opts));
    },
    fillForm(
      fields: readonly BrowserFormField[],
      opts?: BrowserActionOptions,
    ): Promise<Result<void, KoiError>> {
      return delegateOrError("fillForm", (pw) => pw.fillForm(fields, opts));
    },
    scroll(opts: BrowserScrollOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("scroll", (pw) => pw.scroll(opts));
    },
    screenshot(
      opts?: BrowserScreenshotOptions,
    ): Promise<Result<BrowserScreenshotResult, KoiError>> {
      return delegateOrError("screenshot", (pw) => pw.screenshot(opts));
    },
    wait(opts: BrowserWaitOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("wait", (pw) => pw.wait(opts));
    },
    // Tab management does NOT forward to the Playwright delegate: the
    // delegate uses synthetic `tab-N` IDs while browser-ext's tabList returns
    // Chrome's numeric tab IDs. Forwarding would address a different tab set
    // than the caller sees in tabList results, breaking the BrowserDriver
    // contract. Callers should use selectTargetTab(tabId, origin) to pick a
    // tab (invalidating the cached delegate so the next interaction attaches
    // to the new target) instead.
    async tabNew(opts?: BrowserTabNewOptions): Promise<Result<BrowserTabInfo, KoiError>> {
      // Apply the same scheme + private-address validation as navigate()
      // before forwarding to chrome.tabs.create. Without this, an agent
      // could open http://127.0.0.1, file://, chrome://, javascript:, etc.
      // via tabNew({url}) and bypass the guard that navigate() enforces.
      if (opts?.url !== undefined) {
        let parsed: URL;
        try {
          parsed = new URL(opts.url);
        } catch {
          return {
            ok: false,
            error: createExtensionError("HOST_SPAWN_FAILED", `tabNew: invalid URL: ${opts.url}`),
          };
        }
        const scheme = parsed.protocol;
        if (scheme !== "http:" && scheme !== "https:" && scheme !== "about:") {
          return {
            ok: false,
            error: createExtensionError(
              "EXT_USER_DENIED",
              `tabNew blocked non-HTTP(S) scheme: ${scheme}. Allowed: http://, https://, about:.`,
            ),
          };
        }
        const hostname = parsed.hostname;
        const bare =
          hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
        const isIpLiteral =
          /^\d+(\.\d+){3}$/.test(bare) || (bare.includes(":") && /^[\da-fA-F:.]+$/.test(bare));
        const isLocalHostname = bare === "localhost" || bare.endsWith(".localhost");
        if (isLocalHostname || (isIpLiteral && isRfc1918OrLoopback(bare))) {
          return {
            ok: false,
            error: createExtensionError(
              "EXT_USER_DENIED",
              `tabNew blocked private-address target: ${opts.url}`,
            ),
          };
        }
        // Hostname — resolve and check. Without this, a public-looking name
        // that resolves to RFC1918/loopback (split-horizon or DNS rebinding
        // target) would bypass the guard because tabs.create fires the
        // network request before any Playwright route is installed.
        //
        // Fail CLOSED on DNS lookup failure: unlike navigate(), tabNew
        // opens the tab via chrome.tabs.create immediately, BEFORE any
        // page-level rebinding guard exists for the new tab. A
        // browser-only-resolvable hostname (enterprise / hosts file /
        // mDNS / split-horizon) that Node can't resolve would otherwise
        // reach an internal service with no recourse.
        if (!isIpLiteral && !isLocalHostname) {
          try {
            const addresses = await dnsPromises.lookup(bare, { all: true, verbatim: true });
            for (const { address } of addresses) {
              if (isRfc1918OrLoopback(address)) {
                return {
                  ok: false,
                  error: createExtensionError(
                    "EXT_USER_DENIED",
                    `tabNew blocked private-address-resolving hostname: ${bare} → ${address}`,
                  ),
                };
              }
            }
          } catch (err) {
            return {
              ok: false,
              error: createExtensionError(
                "EXT_USER_DENIED",
                `tabNew blocked unresolvable hostname: ${bare}. tabNew opens before any page-level guard exists; fail-closed policy denies unresolved names. (${err instanceof Error ? err.message : String(err)})`,
              ),
            };
          }
        }
      }
      const result = await runtime.openTab(opts?.url);
      if (result.ok) {
        const numericTabId = Number(result.value.tabId);
        if (Number.isFinite(numericTabId)) {
          let origin = "about:blank";
          try {
            origin = new URL(result.value.url).origin;
          } catch {
            // keep default — about:blank lets the next navigate() set origin
          }
          selectedTarget = { tabId: numericTabId, origin };
          invalidateDelegateCache();
        }
      }
      return result;
    },
    async tabClose(
      tabId?: string,
      _opts?: BrowserTabCloseOptions,
    ): Promise<Result<void, KoiError>> {
      if (tabId === undefined) {
        return {
          ok: false,
          error: createExtensionError(
            "HOST_SPAWN_FAILED",
            "tabClose requires a tabId (Chrome numeric tab id as string).",
          ),
        };
      }
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return {
          ok: false,
          error: createExtensionError(
            "HOST_SPAWN_FAILED",
            `tabClose: tabId "${tabId}" is not a valid Chrome numeric id.`,
          ),
        };
      }
      const result = await runtime.closeTab(numericTabId);
      // If we just closed the active target tab, the cached delegate + bridge
      // are pointed at a tab that no longer exists. Invalidate them so the
      // next interaction does not hit a stale session — callers must
      // selectTargetTab() again before interacting.
      if (result.ok && selectedTarget !== null && selectedTarget.tabId === numericTabId) {
        selectedTarget = null;
        invalidateDelegateCache();
      }
      return result;
    },
    async tabFocus(
      tabId: string,
      _opts?: BrowserTabFocusOptions,
    ): Promise<Result<BrowserTabInfo, KoiError>> {
      // tabFocus in the composed driver means "switch the attached tab".
      // Resolve tabId against the native-host tabList to get its origin, then
      // call selectTargetTab — this invalidates the cached delegate so the
      // next interaction attaches to the newly focused tab.
      const tabsResult = await runtime.tabList();
      if (!tabsResult.ok) return tabsResult;
      const tab = tabsResult.value.find((t) => t.tabId === tabId);
      if (!tab) {
        return {
          ok: false,
          error: createExtensionError(
            "HOST_SPAWN_FAILED",
            `tabFocus: no tab with id ${tabId} in native-host tab list.`,
          ),
        };
      }
      let origin = "about:blank";
      try {
        origin = new URL(tab.url).origin;
      } catch {
        // keep default
      }
      const numericTabId = Number(tabId);
      if (Number.isFinite(numericTabId)) {
        selectedTarget = { tabId: numericTabId, origin };
        invalidateDelegateCache();
      }
      return { ok: true, value: tab };
    },
    async evaluate(
      _script: string,
      _opts?: BrowserEvaluateOptions,
    ): Promise<Result<BrowserEvaluateResult, KoiError>> {
      // Structurally unsupported on browser-ext: the delegate is always a
      // borrowed (live user tab) context, where page.evaluate() cannot be
      // cancelled safely — a timed-out script keeps mutating the user's
      // session. Reject at the API boundary so callers don't discover the
      // capability and hit a deterministic PERMISSION failure downstream.
      return {
        ok: false,
        error: createExtensionError(
          "EXT_USER_DENIED",
          "evaluate() is not supported on browser-ext. The attached tab is a live user " +
            "session and page.evaluate() cannot be cancelled safely — use snapshot + " +
            "click/type/fillForm for scripted interaction instead.",
        ),
      };
    },
    hover(ref: string, opts?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("hover", (pw) => pw.hover(ref, opts));
    },
    press(key: string, opts?: BrowserActionOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("press", (pw) => pw.press(key, opts));
    },
    tabList(): Promise<Result<readonly BrowserTabInfo[], KoiError>> {
      return runtime.tabList();
    },
    console(opts?: BrowserConsoleOptions): Promise<Result<BrowserConsoleResult, KoiError>> {
      return delegateOrError("console", (pw) => pw.console(opts));
    },
    upload(
      ref: string,
      files: readonly BrowserUploadFile[],
      opts?: BrowserUploadOptions,
    ): Promise<Result<void, KoiError>> {
      return delegateOrError("upload", (pw) =>
        pw.upload ? pw.upload(ref, files, opts) : missingPlaywrightError("upload"),
      );
    },
    async traceStart(_opts?: BrowserTraceOptions): Promise<Result<void, KoiError>> {
      // Structurally unsupported on browser-ext: Playwright tracing captures
      // every page in the context, including the user's other tabs. That
      // would exfiltrate unrelated browsing data from a live user session.
      return {
        ok: false,
        error: createExtensionError(
          "EXT_USER_DENIED",
          "traceStart() is not supported on browser-ext. Tracing would capture caller-owned " +
            "tabs in the user's live browser session. Use a driver-owned browser (launch " +
            "mode via @koi/browser-playwright) if tracing is needed.",
        ),
      };
    },
    async traceStop(): Promise<Result<BrowserTraceResult, KoiError>> {
      return {
        ok: false,
        error: createExtensionError(
          "EXT_USER_DENIED",
          "traceStop() is not supported on browser-ext (tracing cannot start on this transport).",
        ),
      };
    },
    async dispose(): Promise<void> {
      if (cachedBridge) {
        await cachedBridge.close().catch(() => {});
        cachedBridge = null;
      }
      if (cachedDelegate) {
        await cachedDelegate.dispose?.();
        cachedDelegate = null;
      }
      // Await any queued bridge teardown from earlier tab-switch /
      // transport-loss invalidations. Without this, an in-flight
      // bridge.close() can run AFTER runtime.dispose() — which means its
      // host-side detach goes to a closed transport and is silently
      // swallowed, leaking a committed attach owner on the host side.
      await pendingBridgeClose.catch(() => {});
      await runtime.dispose();
    },
    attachLoopbackBridge(tabId, origin) {
      return runtime.attachLoopbackBridge(tabId, origin);
    },
    selectTargetTab(tabId, origin): void {
      // Invalidate the cached delegate on target change — otherwise the
      // previously-initialized Playwright bridge would keep driving the
      // original tab even after the caller picked a different one.
      const sameTarget =
        selectedTarget !== null &&
        selectedTarget.tabId === tabId &&
        selectedTarget.origin === origin;
      selectedTarget = { tabId, origin };
      if (sameTarget) return;
      invalidateDelegateCache();
    },
  };
}

/**
 * Composition pattern note — to build a fully-working browser driver from
 * `@koi/browser-ext`, callers must wire both this package's extension driver
 * and `@koi/browser-playwright` themselves. The canonical recipe:
 *
 * ```ts
 * import { createExtensionBrowserDriver, createLoopbackWebSocketBridge, createDriverClient } from "@koi/browser-ext";
 * import { createPlaywrightBrowserDriver } from "@koi/browser-playwright";
 *
 * const ext = createExtensionBrowserDriver({});
 * const tabs = await ext.tabList();
 * const sessionId = (await ext.attachLoopbackBridge(tabId, origin)).value;
 * const client = createDriverClient(socketPath);
 * const bridge = await createLoopbackWebSocketBridge({ token, sessionId, transport: client });
 * const pw = createPlaywrightBrowserDriver({
 *   wsEndpoint: bridge.endpoint,
 *   wsHeaders: { Authorization: `Bearer ${token}` },
 * });
 * // Use `pw` for snapshot/navigate/click/type/etc. Use `ext.tabList()` for
 * // authoritative tab enumeration.
 * // On shutdown: await bridge.close(); await pw.dispose?.(); await ext.dispose();
 * ```
 *
 * A single factory that auto-composes this is intentionally not exported —
 * the wiring depends on caller-specific choices (initial tab selection, token
 * generation, lifecycle ordering) that vary across runtime / CLI / test use.
 */
