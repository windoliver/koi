import { randomBytes, randomUUID } from "node:crypto";
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
   * Optional delegate `BrowserDriver` the extension driver forwards
   * interaction methods (snapshot, navigate, click, type, …) to. Caller owns
   * its lifecycle — this driver does NOT dispose it. Takes precedence over
   * `createPlaywrightDriver`. Type-only reference (`BrowserDriver` is L0) —
   * avoids L2-to-L2 coupling to `@koi/browser-playwright`.
   */
  readonly playwrightDriver?: BrowserDriver | undefined;
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
      `${operation}: no playwrightDriver was supplied to createExtensionBrowserDriver. ` +
        "Spin up a loopback bridge via the extension driver and pass a Playwright-backed BrowserDriver " +
        "via ExtensionDriverConfig.playwrightDriver to delegate interaction methods.",
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
   * Ignored if `playwrightDriver` is supplied (caller owns selection there).
   */
  readonly selectTargetTab: (tabId: number, origin: string) => void;
}

/**
 * **IMPORTANT — this is a PARTIAL BrowserDriver.**
 *
 * Without an injected `playwrightDriver` in `options`, every interaction
 * method (snapshot, navigate, click, type, evaluate, etc.) returns a clear
 * error — only `tabList()` and `attachLoopbackBridge()` work. This is by
 * design: `@koi/browser-ext` (L2) must not depend directly on
 * `@koi/browser-playwright` (also L2) — that would violate the layer
 * architecture. Composition is therefore a CALLER RESPONSIBILITY, ideally
 * done at L3 (runtime) via `composeExtensionBrowserDriver` below.
 *
 * Returns an `ExtensionBrowserDriver` (augmented `BrowserDriver` +
 * `attachLoopbackBridge`). See the composition recipe documented above.
 */
export function createExtensionBrowserDriver(
  options: ExtensionDriverConfig = {},
): ExtensionBrowserDriver {
  const runtime = new ExtensionBrowserDriverRuntime(options);

  let cachedDelegate: BrowserDriver | null = options.playwrightDriver ?? null;
  let cachedBridge: LoopbackWebSocketBridge | null = null;
  let ownsDelegate = false;
  let ensurePromise: Promise<Result<BrowserDriver, KoiError>> | null = null;
  let selectedTarget: { tabId: number; origin: string } | null = null;
  // Monotonic generation: bump on every invalidation (target change /
  // transport loss). In-flight delegate-creation captures its generation
  // at start; if the generation advances before completion, the stale
  // completion is discarded instead of overwriting the cache for a different
  // target.
  let delegateGeneration = 0;

  function invalidateDelegateCache(): void {
    const bridge = cachedBridge;
    const delegate = ownsDelegate ? cachedDelegate : null;
    cachedBridge = null;
    cachedDelegate = options.playwrightDriver ?? null;
    ownsDelegate = false;
    ensurePromise = null;
    delegateGeneration += 1;
    void bridge?.close().catch(() => {});
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
      ownsDelegate = true;
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
    async tabNew(_opts?: BrowserTabNewOptions): Promise<Result<BrowserTabInfo, KoiError>> {
      return {
        ok: false,
        error: createExtensionError(
          "HOST_SPAWN_FAILED",
          "tabNew is not supported on the composed browser-ext driver. Open a new tab " +
            "in Chrome yourself, then call selectTargetTab(newTabId, origin).",
        ),
      };
    },
    async tabClose(
      _tabId?: string,
      _opts?: BrowserTabCloseOptions,
    ): Promise<Result<void, KoiError>> {
      return {
        ok: false,
        error: createExtensionError(
          "HOST_SPAWN_FAILED",
          "tabClose is not supported on the composed browser-ext driver. Close the tab in " +
            "Chrome directly.",
        ),
      };
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
    evaluate(
      script: string,
      opts?: BrowserEvaluateOptions,
    ): Promise<Result<BrowserEvaluateResult, KoiError>> {
      return delegateOrError("evaluate", (pw) => pw.evaluate(script, opts));
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
    traceStart(opts?: BrowserTraceOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("traceStart", (pw) =>
        pw.traceStart ? pw.traceStart(opts) : missingPlaywrightError("traceStart"),
      );
    },
    traceStop(): Promise<Result<BrowserTraceResult, KoiError>> {
      return delegateOrError("traceStop", (pw) =>
        pw.traceStop ? pw.traceStop() : missingPlaywrightError("traceStop"),
      );
    },
    async dispose(): Promise<void> {
      if (cachedBridge) {
        await cachedBridge.close().catch(() => {});
        cachedBridge = null;
      }
      if (cachedDelegate && ownsDelegate) {
        await cachedDelegate.dispose?.();
        cachedDelegate = null;
        ownsDelegate = false;
      }
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
