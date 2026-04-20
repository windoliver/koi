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
   * to produce a Playwright-backed delegate. When provided, the driver:
   *   1. Auto-attaches to the first tab via the native host on first
   *      interaction-method call (snapshot / navigate / click / …).
   *   2. Stands up a loopback WS bridge over the attached CDP session.
   *   3. Invokes this callback with `{ wsEndpoint, wsHeaders }` where
   *      `wsHeaders = { Authorization: "Bearer <token>" }`.
   *   4. Caches the returned driver and forwards all interaction methods.
   *
   * The callback is called exactly once per extension-driver lifetime. The
   * returned driver is disposed on `driver.dispose()` — caller does not
   * need to manage its lifecycle separately. Use this instead of
   * `playwrightDriver` when you want the extension driver to own composition.
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
const DEFAULT_TOKEN_PATH: string = join(homedir(), ".koi/browser-ext/token");

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
  return (await readFile(DEFAULT_TOKEN_PATH, "utf-8")).trim();
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
    const connection = this.activeConnection;
    this.activeConnection = null;
    this.connectionPromise = null;
    await connection?.client.close();
  }

  public async getTransport(): Promise<ReturnType<typeof createDriverClient>> {
    const conn = await this.ensureConnection();
    return conn.client;
  }

  private onTransportLost(): void {
    this.activeConnection = null;
    this.connectionPromise = null;
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
  let ensurePromise: Promise<BrowserDriver | null> | null = null;

  async function ensureDelegate(): Promise<BrowserDriver | null> {
    if (cachedDelegate !== null) return cachedDelegate;
    if (!options.createPlaywrightDriver) return null;
    if (ensurePromise) return ensurePromise;

    ensurePromise = (async (): Promise<BrowserDriver | null> => {
      try {
        const tabsResult = await runtime.tabList();
        if (!tabsResult.ok) return null;
        const firstTab = tabsResult.value[0];
        if (!firstTab) return null;
        const numericTabId = Number(firstTab.tabId);
        if (!Number.isFinite(numericTabId)) return null;

        let origin = "about:blank";
        try {
          origin = new URL(firstTab.url).origin;
        } catch {
          // Unparseable tab URL (e.g. chrome internal) — attach still works;
          // the tool layer enforces origin-based policy downstream.
        }

        const sessionResult = await runtime.attachLoopbackBridge(numericTabId, origin);
        if (!sessionResult.ok) return null;

        const token = randomBytes(16).toString("hex");
        const transport = await runtime.getTransport();
        const factory = options.createPlaywrightDriver;
        if (!factory) return null;
        const bridge = await createLoopbackWebSocketBridge({
          token,
          sessionId: sessionResult.value,
          transport,
        });

        const delegate = await factory({
          wsEndpoint: bridge.endpoint,
          wsHeaders: { Authorization: `Bearer ${token}` },
        });

        cachedDelegate = delegate;
        cachedBridge = bridge;
        ownsDelegate = true;
        return delegate;
      } catch {
        return null;
      }
    })();
    return ensurePromise;
  }

  async function delegateOrError<T>(
    op: string,
    fn: (pw: BrowserDriver) => Result<T, KoiError> | Promise<Result<T, KoiError>>,
  ): Promise<Result<T, KoiError>> {
    const pw = await ensureDelegate();
    if (!pw) return missingPlaywrightError(op);
    return await fn(pw);
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
    tabNew(opts?: BrowserTabNewOptions): Promise<Result<BrowserTabInfo, KoiError>> {
      return delegateOrError("tabNew", (pw) => pw.tabNew(opts));
    },
    tabClose(tabId?: string, opts?: BrowserTabCloseOptions): Promise<Result<void, KoiError>> {
      return delegateOrError("tabClose", (pw) => pw.tabClose(tabId, opts));
    },
    tabFocus(
      tabId: string,
      opts?: BrowserTabFocusOptions,
    ): Promise<Result<BrowserTabInfo, KoiError>> {
      return delegateOrError("tabFocus", (pw) => pw.tabFocus(tabId, opts));
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
