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
import { createDriverClient } from "./unix-socket-transport.js";

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
   * Optional delegate `BrowserDriver` that this extension driver forwards
   * interaction methods (snapshot, navigate, click, type, …) to. The typical
   * composition (performed by the L3 runtime, not this L2 package) is:
   *
   *   1. Create an extension driver (this) for discovery + tabList + loopback
   *      bridge plumbing.
   *   2. Attach to a tab via the native host to obtain a CDP session.
   *   3. Stand up a loopback WS endpoint (exposed via `attachLoopbackBridge`)
   *      that bridges the CDP session from the extension.
   *   4. Create a Playwright-backed driver via
   *      `createPlaywrightBrowserDriver({ wsEndpoint, wsHeaders })`.
   *   5. Pass that Playwright driver in here.
   *
   * `tabList` always goes through the native host directly — the MV3 extension
   * is the source of truth for the live tab set, not Playwright.
   *
   * The caller owns the injected driver's lifecycle — this driver does NOT
   * dispose it. If omitted, interaction methods return a clear error.
   *
   * Type-only reference (`BrowserDriver` is L0); this keeps `@koi/browser-ext`
   * free of L2-to-L2 coupling to `@koi/browser-playwright`.
   */
  readonly playwrightDriver?: BrowserDriver | undefined;
}

const DEFAULT_INSTANCES_DIR: string = join(homedir(), ".koi/browser-ext/instances");
const DEFAULT_TOKEN_PATH: string = join(homedir(), ".koi/browser-ext/token");

interface RuntimeConnection {
  readonly socketPath: string;
  readonly client: ReturnType<typeof createDriverClient>;
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

    const hello = await client.hello({
      kind: "hello",
      token,
      driverVersion: "0.0.0",
      supportedProtocols: [1],
      leaseToken: randomBytes(16).toString("hex"),
    });

    if (hello.ok !== true) {
      await client.close();
      throw createExtensionError(
        "HOST_SPAWN_FAILED",
        `Browser extension host handshake failed: ${hello.reason}`,
        { reason: hello.reason },
      );
    }

    const connection: RuntimeConnection = {
      socketPath: selected.socket,
      client,
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
        leaseToken: randomBytes(16).toString("hex"),
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

export function createExtensionBrowserDriver(options: ExtensionDriverConfig = {}): BrowserDriver {
  const runtime = new ExtensionBrowserDriverRuntime(options);
  const pw = options.playwrightDriver;

  return {
    name: "browser-ext",
    snapshot(
      opts?: BrowserSnapshotOptions,
    ): Result<BrowserSnapshotResult, KoiError> | Promise<Result<BrowserSnapshotResult, KoiError>> {
      return pw ? pw.snapshot(opts) : missingPlaywrightError("snapshot");
    },
    navigate(
      url: string,
      opts?: BrowserNavigateOptions,
    ): Result<BrowserNavigateResult, KoiError> | Promise<Result<BrowserNavigateResult, KoiError>> {
      return pw ? pw.navigate(url, opts) : missingPlaywrightError("navigate");
    },
    click(
      ref: string,
      opts?: BrowserActionOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.click(ref, opts) : missingPlaywrightError("click");
    },
    type(
      ref: string,
      value: string,
      opts?: BrowserTypeOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.type(ref, value, opts) : missingPlaywrightError("type");
    },
    select(
      ref: string,
      value: string,
      opts?: BrowserActionOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.select(ref, value, opts) : missingPlaywrightError("select");
    },
    fillForm(
      fields: readonly BrowserFormField[],
      opts?: BrowserActionOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.fillForm(fields, opts) : missingPlaywrightError("fillForm");
    },
    scroll(opts: BrowserScrollOptions): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.scroll(opts) : missingPlaywrightError("scroll");
    },
    screenshot(
      opts?: BrowserScreenshotOptions,
    ):
      | Result<BrowserScreenshotResult, KoiError>
      | Promise<Result<BrowserScreenshotResult, KoiError>> {
      return pw ? pw.screenshot(opts) : missingPlaywrightError("screenshot");
    },
    wait(opts: BrowserWaitOptions): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.wait(opts) : missingPlaywrightError("wait");
    },
    tabNew(
      opts?: BrowserTabNewOptions,
    ): Result<BrowserTabInfo, KoiError> | Promise<Result<BrowserTabInfo, KoiError>> {
      return pw ? pw.tabNew(opts) : missingPlaywrightError("tabNew");
    },
    tabClose(
      tabId?: string,
      opts?: BrowserTabCloseOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.tabClose(tabId, opts) : missingPlaywrightError("tabClose");
    },
    tabFocus(
      tabId: string,
      opts?: BrowserTabFocusOptions,
    ): Result<BrowserTabInfo, KoiError> | Promise<Result<BrowserTabInfo, KoiError>> {
      return pw ? pw.tabFocus(tabId, opts) : missingPlaywrightError("tabFocus");
    },
    evaluate(
      script: string,
      opts?: BrowserEvaluateOptions,
    ): Result<BrowserEvaluateResult, KoiError> | Promise<Result<BrowserEvaluateResult, KoiError>> {
      return pw ? pw.evaluate(script, opts) : missingPlaywrightError("evaluate");
    },
    hover(
      ref: string,
      opts?: BrowserActionOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.hover(ref, opts) : missingPlaywrightError("hover");
    },
    press(
      key: string,
      opts?: BrowserActionOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw ? pw.press(key, opts) : missingPlaywrightError("press");
    },
    tabList(): Promise<Result<readonly BrowserTabInfo[], KoiError>> {
      return runtime.tabList();
    },
    console(
      opts?: BrowserConsoleOptions,
    ): Result<BrowserConsoleResult, KoiError> | Promise<Result<BrowserConsoleResult, KoiError>> {
      return pw ? pw.console(opts) : missingPlaywrightError("console");
    },
    upload(
      ref: string,
      files: readonly BrowserUploadFile[],
      opts?: BrowserUploadOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw?.upload ? pw.upload(ref, files, opts) : missingPlaywrightError("upload");
    },
    traceStart(
      opts?: BrowserTraceOptions,
    ): Result<void, KoiError> | Promise<Result<void, KoiError>> {
      return pw?.traceStart ? pw.traceStart(opts) : missingPlaywrightError("traceStart");
    },
    traceStop():
      | Result<BrowserTraceResult, KoiError>
      | Promise<Result<BrowserTraceResult, KoiError>> {
      return pw?.traceStop ? pw.traceStop() : missingPlaywrightError("traceStop");
    },
    dispose(): Promise<void> {
      return runtime.dispose();
    },
  };
}
