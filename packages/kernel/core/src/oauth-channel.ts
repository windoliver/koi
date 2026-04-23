/**
 * Shared OAuth authorization channel protocol.
 *
 * Both nexus bridge and MCP connections emit through this interface.
 * The CLI wires a single concrete implementation that renders inline
 * chat messages and routes `submitAuthCode` to the appropriate transport.
 */

/**
 * Emitted when a provider requires OAuth authorization.
 *
 * `authUrl` is optional — nexus always supplies it (user may need to
 * paste it manually in remote mode); MCP omits it because the browser
 * opens automatically via the local callback server.
 */
export interface AuthRequiredNotification {
  readonly provider: string;
  readonly authUrl?: string | undefined;
  readonly message: string;
  /** "local" — loopback callback handles code exchange automatically.
   *  "remote" — user must paste the full redirect URL back into chat. */
  readonly mode: "local" | "remote";
  readonly correlationId?: string | undefined;
  readonly instructions?: string | undefined;
}

/** Emitted when OAuth authorization completes successfully. */
export interface AuthCompleteNotification {
  readonly provider: string;
}

/**
 * Shared protocol for OAuth authorization UX.
 *
 * Producers (nexus transport, MCP connection) call `onAuthRequired` /
 * `onAuthComplete` as side effects during the auth lifecycle.
 * The CLI's `createOAuthChannel` factory is the single concrete implementation.
 */
export interface OAuthChannel {
  readonly onAuthRequired: (n: AuthRequiredNotification) => void;
  readonly onAuthComplete: (n: AuthCompleteNotification) => void;
  /** Forward a pasted redirect URL to the transport (remote mode only). */
  readonly submitAuthCode: (redirectUrl: string, correlationId?: string) => void;
}
