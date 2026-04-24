/**
 * CLI OAuth channel — single renderer for both nexus and MCP OAuth flows.
 *
 * Produces inline chat messages for auth_required and auth_complete events.
 * submitAuthCode forwards pasted redirect URLs to the transport (remote mode only).
 */

import type {
  AuthCompleteNotification,
  AuthFailureNotification,
  AuthRequiredNotification,
  ChannelAdapter,
  OAuthChannel,
} from "@koi/core";

function buildAuthRequiredText(n: AuthRequiredNotification): string {
  if (n.authUrl === undefined) {
    return `**${n.message}**`;
  }

  if (n.mode === "remote") {
    // Remote flows: callback is reachable from any host — show the URL as a
    // primary action link and include any instructions (e.g., "paste redirect URL").
    const remoteHint = n.instructions !== undefined ? `\n\n_${n.instructions}_` : "";
    return `**${n.message}**\n\nOpen this link in your browser to authorize ${n.provider}:\n${n.authUrl}${remoteHint}`;
  }

  // mode:"local" with authUrl — the URL is navigable (e.g. Nexus OAuth where
  // the user must open a browser on the same machine). Show as a fallback link.
  // MCP loopback flows must NOT pass authUrl here — they include recovery
  // instructions in the message field instead.
  return `**${n.message}**\n\n_If the browser does not open automatically, open this link to authorize ${n.provider}:_\n${n.authUrl}`;
}

export function createOAuthChannel(options: {
  readonly channel: ChannelAdapter;
  readonly onSubmit?: (url: string, correlationId?: string | undefined) => void;
}): OAuthChannel {
  const { channel, onSubmit } = options;

  return {
    async onAuthRequired(n: AuthRequiredNotification): Promise<void> {
      const text = buildAuthRequiredText(n);
      try {
        await channel.send({ content: [{ kind: "text", text }] });
      } catch (_err: unknown) {
        // eslint-disable-next-line no-console
        console.error(
          `[oauth-channel] Failed to send auth_required message for provider: ${n.provider}`,
          _err,
        );
      }
    },

    async onAuthComplete(n: AuthCompleteNotification): Promise<void> {
      const text = `${n.provider} authorization complete. Continuing...`;
      try {
        await channel.send({ content: [{ kind: "text", text }] });
      } catch (_err: unknown) {
        // auth_complete delivery failure is non-blocking — auth already succeeded.
        // eslint-disable-next-line no-console
        console.warn(
          `[oauth-channel] auth_complete delivery failed for ${n.provider}: ${String(_err)}`,
        );
      }
    },

    async onAuthFailure(n: AuthFailureNotification): Promise<void> {
      const text = `**${n.provider} authorization failed:** ${n.reason}`;
      try {
        await channel.send({ content: [{ kind: "text", text }] });
      } catch (_err: unknown) {
        // eslint-disable-next-line no-console
        console.warn(
          `[oauth-channel] auth_failure delivery failed for ${n.provider}: ${String(_err)}`,
        );
      }
    },

    submitAuthCode(redirectUrl: string, correlationId?: string | undefined): void {
      if (onSubmit !== undefined) {
        onSubmit(redirectUrl, correlationId);
      }
    },
  };
}
