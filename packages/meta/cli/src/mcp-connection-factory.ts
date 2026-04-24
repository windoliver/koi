/**
 * OAuth-aware MCP connection factory.
 *
 * Wraps createMcpConnection to automatically attach an OAuthAuthProvider
 * when the server config has an `oauth` field and stored tokens exist.
 * Used by tui-runtime, start command, and mcp CLI commands.
 */

import type { OAuthChannel } from "@koi/core";
import type { McpConnection, McpServerConfig, OAuthAuthProvider } from "@koi/mcp";
import { createMcpConnection, createOAuthAuthProvider, resolveServerConfig } from "@koi/mcp";
import { createSecureStorage } from "@koi/secure-storage";
import { createCliOAuthRuntime } from "./commands/mcp-oauth-runtime.js";

/** Injectable factories for testing. All fields are optional — defaults are the real implementations. */
export interface OAuthAwareMcpConnectionDeps {
  readonly createConnection?: typeof createMcpConnection;
  readonly createAuthProvider?: typeof createOAuthAuthProvider;
  readonly createStorage?: typeof createSecureStorage;
  readonly createRuntime?: typeof createCliOAuthRuntime;
}

/**
 * Creates an MCP connection, attaching an OAuth auth provider when the
 * server config includes an `oauth` field.
 *
 * When `authProviderSink` is provided, stores the auth provider keyed
 * by server name so the auth tool factory can access it later.
 *
 * When `oauthChannel` is provided and the server requires OAuth, wires
 * `onAuthNeeded` so that mid-session 401s trigger the interactive auth
 * flow via the channel and reconnect automatically on success.
 */
export function createOAuthAwareMcpConnection(
  server: McpServerConfig,
  authProviderSink?: Map<string, OAuthAuthProvider> | undefined,
  oauthChannel?: OAuthChannel | undefined,
  deps?: OAuthAwareMcpConnectionDeps | undefined,
): McpConnection {
  const {
    createConnection = createMcpConnection,
    createAuthProvider = createOAuthAuthProvider,
    createStorage = createSecureStorage,
    createRuntime = createCliOAuthRuntime,
  } = deps ?? {};

  const resolved = resolveServerConfig(server);

  if (server.kind === "http" && server.oauth !== undefined) {
    // Fail closed: if secure storage is unavailable, surface the error
    // rather than silently connecting without credentials (which would
    // cause opaque 401s instead of a clear platform error).
    const storage = createStorage();
    // Fire onAuthRequired the moment the browser is about to open so the TUI
    // shows a "browser opening" status without blocking the launch.
    // MCP uses a local loopback callback (127.0.0.1) that is not reachable from
    // remote hosts — do NOT include authUrl here since the URL is not a usable
    // paste-in fallback for headless/SSH sessions. The console already logs it
    // as a machine-local fallback via startCallbackServer.
    const runtime = createRuntime(
      oauthChannel !== undefined
        ? {
            onBrowserOpen: (authorizationUrl: string): void => {
              void Promise.resolve(
                oauthChannel.onAuthRequired({
                  provider: server.name,
                  // Include the URL so the TUI can show it as a manual fallback
                  // if the browser launch fails. mode:"local" signals that the
                  // callback server runs on 127.0.0.1 — the URL must be opened on
                  // the same machine as Koi, not on a remote browser.
                  authUrl: authorizationUrl,
                  message: `Opening browser to authorize ${server.name}`,
                  mode: "local",
                }),
              ).catch(() => {});
            },
          }
        : undefined,
    );
    const provider = createAuthProvider({
      serverName: server.name,
      serverUrl: server.url,
      oauthConfig: server.oauth,
      runtime,
      storage,
    });

    authProviderSink?.set(server.name, provider);

    const onAuthNeeded =
      oauthChannel !== undefined
        ? async (): Promise<boolean> => {
            // onBrowserOpen (wired into the runtime above) fires onAuthRequired
            // with the actual authorization URL the moment it is known — no need
            // for an early generic notification here.
            const authed = await provider.startAuthFlow();
            if (authed) {
              // Notify best-effort — auth is already done regardless.
              await Promise.resolve(oauthChannel.onAuthComplete({ provider: server.name })).catch(
                () => {},
              );
            } else {
              // Surface the failure reason so the TUI can show actionable info
              // rather than a generic AUTH_REQUIRED error.
              void Promise.resolve(
                oauthChannel.onAuthFailure?.({
                  provider: server.name,
                  reason: "Authorization was cancelled or failed. Retry via the /mcp panel.",
                }),
              ).catch(() => {});
            }
            return authed;
          }
        : undefined;

    return createConnection(resolved, provider, {
      onUnauthorized: () => provider.handleUnauthorized(),
      ...(onAuthNeeded !== undefined ? { onAuthNeeded } : {}),
    });
  }

  return createConnection(resolved);
}
