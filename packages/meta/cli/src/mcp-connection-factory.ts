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

function formatOAuthFailureReason(r: {
  readonly kind: string;
  readonly detail?: string | undefined;
}): string {
  switch (r.kind) {
    case "discovery_failed":
      return "Authorization server discovery failed. Check the server URL and OAuth config.";
    case "dcr_unavailable":
      return "Dynamic client registration endpoint is unavailable on this server.";
    case "dcr_failed":
      return `Client registration failed${r.detail !== undefined ? `: ${r.detail}` : ""}.`;
    case "exchange_failed":
      return "Authorization code exchange failed. Try authorizing again.";
    case "state_mismatch":
      return "OAuth state mismatch (possible CSRF). Authorization aborted.";
    case "authorize_failed":
      return `Browser authorization failed${r.detail !== undefined ? `: ${r.detail}` : ""}.`;
    default:
      return "OAuth authorization failed. Retry via the /mcp panel.";
  }
}

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
    // MCP uses a local loopback callback (127.0.0.1). Pass authorizationUrl so
    // the user can copy-paste it into their local browser if auto-open fails.
    // The message also includes a CLI fallback for SSH/headless environments.
    // let justified: captures last structured failure reason so onAuthNeeded
    // can surface it instead of a generic "failed" message.
    let lastOAuthFailure:
      | { readonly kind: string; readonly detail?: string | undefined }
      | undefined;
    const runtime = createRuntime(
      oauthChannel !== undefined
        ? {
            onBrowserOpen: (authorizationUrl: string): void => {
              // MCP OAuth callback runs on 127.0.0.1 — the URL cannot complete
              // the flow from a remote/SSH session. Pass authorizationUrl so the
              // user can manually copy-paste it into their local browser if
              // auto-open fails. Remote/SSH users also see the CLI fallback.
              void Promise.resolve(
                oauthChannel.onAuthRequired({
                  provider: server.name,
                  message: `Opening browser to authorize ${server.name}.`,
                  mode: "local",
                  authUrl: authorizationUrl,
                  instructions: `On a remote or headless machine, run instead: \`koi mcp auth ${server.name}\``,
                }),
              ).catch(() => {});
            },
            onAuthFailure: (reason: {
              readonly kind: string;
              readonly detail?: string | undefined;
            }): void => {
              lastOAuthFailure = reason;
              // Eagerly surface the structured reason to the channel so
              // the TUI can show actionable diagnostics without waiting for
              // onAuthNeeded to fire (e.g., DCR failure before browser opens).
              void Promise.resolve(
                oauthChannel.onAuthFailure?.({
                  provider: server.name,
                  reason: formatOAuthFailureReason(reason),
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
            // the moment the browser opens — no need for an early notification here.
            // Reset lastOAuthFailure before each attempt so stale reasons don't
            // persist across retries.
            lastOAuthFailure = undefined;
            const authed = await provider.startAuthFlow();
            if (!authed && lastOAuthFailure === undefined) {
              // No structured failure was reported (e.g., user cancelled in browser) —
              // fire a generic failure so the channel still shows something.
              void Promise.resolve(
                oauthChannel.onAuthFailure?.({
                  provider: server.name,
                  reason: "Authorization was cancelled or did not complete.",
                }),
              ).catch(() => {});
            }
            return authed;
          }
        : undefined;

    // onAuthComplete fires from ConnectionDeps after auth + reconnect both succeed,
    // so consumers receive a "connection ready" signal rather than a premature success.
    const onAuthComplete =
      oauthChannel !== undefined
        ? async (): Promise<void> => {
            await Promise.resolve(oauthChannel.onAuthComplete({ provider: server.name })).catch(
              () => {},
            );
          }
        : undefined;

    return createConnection(resolved, provider, {
      onUnauthorized: () => provider.handleUnauthorized(),
      ...(onAuthNeeded !== undefined ? { onAuthNeeded } : {}),
      ...(onAuthComplete !== undefined ? { onAuthComplete } : {}),
    });
  }

  return createConnection(resolved);
}
