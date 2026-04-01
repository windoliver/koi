/**
 * Transport factory — creates MCP SDK transport instances from config.
 *
 * Returns a KoiMcpTransport wrapper that exposes lifecycle callbacks
 * (onclose, onerror) and session state without leaking SDK types
 * into the Koi API surface.
 */

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpAuthProvider } from "./auth.js";
import type {
  HttpTransportConfig,
  McpTransportConfig,
  SseTransportConfig,
  StdioTransportConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Koi transport wrapper interface
// ---------------------------------------------------------------------------

/** Lifecycle event fired when the underlying transport changes state. */
export type TransportEvent =
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly error: Error };

export type TransportEventListener = (event: TransportEvent) => void;

/**
 * Koi's wrapper around MCP SDK transports.
 * Exposes lifecycle events and session state without leaking SDK internals.
 */
export interface KoiMcpTransport {
  /** Start the transport (called by Client.connect). */
  readonly start: () => Promise<void>;
  /** Close the transport and release resources. */
  readonly close: () => Promise<void>;
  /** The underlying SDK transport for passing to Client.connect(). */
  readonly sdkTransport: unknown;
  /** Session ID from Streamable HTTP (undefined for stdio/SSE). */
  readonly sessionId: string | undefined;
  /** Subscribe to transport lifecycle events. Returns unsubscribe function. */
  readonly onEvent: (listener: TransportEventListener) => () => void;
}

// ---------------------------------------------------------------------------
// SDK transport type (minimal interface for event wiring)
// ---------------------------------------------------------------------------

interface SdkTransportLike {
  start(): Promise<void>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  sessionId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateTransportOptions {
  readonly config: McpTransportConfig;
  readonly authProvider?: McpAuthProvider | undefined;
}

/**
 * Creates a KoiMcpTransport from a transport config.
 * The returned transport has not been started — pass .sdkTransport
 * to Client.connect() to start it.
 */
export function createTransport(options: CreateTransportOptions): KoiMcpTransport {
  const sdkTransport = createSdkTransport(options);
  return wrapSdkTransport(sdkTransport);
}

// ---------------------------------------------------------------------------
// SDK transport creation (exhaustive switch)
// ---------------------------------------------------------------------------

function createStdio(config: StdioTransportConfig): SdkTransportLike {
  const params: { command: string; args?: string[]; env?: Record<string, string> } = {
    command: config.command,
  };
  if (config.args !== undefined) params.args = [...config.args];
  if (config.env !== undefined) params.env = { ...config.env };
  return new StdioClientTransport(params) as unknown as SdkTransportLike;
}

function createHttp(config: HttpTransportConfig, authProvider?: McpAuthProvider): SdkTransportLike {
  const headers: Record<string, string> = config.headers !== undefined ? { ...config.headers } : {};
  // Auth injected via header — SDK's OAuthClientProvider requires full OAuth 2.1 flow.
  if (authProvider !== undefined) {
    const token = authProvider.token();
    const resolved = token instanceof Promise ? undefined : token;
    if (resolved !== undefined) headers.Authorization = `Bearer ${resolved}`;
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  }) as unknown as SdkTransportLike;
}

function createSse(config: SseTransportConfig): SdkTransportLike {
  const opts =
    config.headers !== undefined ? { requestInit: { headers: { ...config.headers } } } : undefined;
  return new SSEClientTransport(new URL(config.url), opts) as unknown as SdkTransportLike;
}

function createSdkTransport(options: CreateTransportOptions): SdkTransportLike {
  const { config, authProvider } = options;
  switch (config.transport) {
    case "stdio":
      return createStdio(config);
    case "http":
      return createHttp(config, authProvider);
    case "sse":
      return createSse(config);
    default: {
      const _exhaustive: never = config;
      throw new Error(
        `Unknown transport type: ${String((_exhaustive as McpTransportConfig).transport)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function wrapSdkTransport(sdk: SdkTransportLike): KoiMcpTransport {
  const listeners = new Set<TransportEventListener>();

  // Wire SDK callbacks to our event system
  sdk.onclose = () => {
    for (const listener of listeners) {
      listener({ kind: "closed" });
    }
  };

  sdk.onerror = (error: Error) => {
    for (const listener of listeners) {
      listener({ kind: "error", error });
    }
  };

  return {
    start: () => sdk.start(),
    close: () => sdk.close(),
    sdkTransport: sdk,
    get sessionId() {
      return sdk.sessionId;
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// DI for testing — allow injecting a mock transport
// ---------------------------------------------------------------------------

export type CreateTransportFn = (options: CreateTransportOptions) => KoiMcpTransport;
