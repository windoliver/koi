/**
 * CLI OAuth channel — single renderer for both nexus and MCP OAuth flows.
 *
 * Produces inline chat messages for auth_required and auth_complete events.
 * submitAuthCode forwards pasted redirect URLs to the transport (remote mode only).
 */

import type {
  AuthCompleteNotification,
  AuthRequiredNotification,
  ChannelAdapter,
  OAuthChannel,
} from "@koi/core";

function buildAuthRequiredText(n: AuthRequiredNotification): string {
  if (n.authUrl === undefined) {
    // MCP local mode — browser opens automatically, no URL to show
    return `**${n.message}**`;
  }

  const remoteHint =
    n.mode === "remote" && n.instructions !== undefined ? `\n\n_${n.instructions}_` : "";

  return `**${n.message}**\n\nOpen this link in your browser to authorize ${n.provider}:\n${n.authUrl}${remoteHint}`;
}

export function createOAuthChannel(options: {
  readonly channel: ChannelAdapter;
  readonly onSubmit?: (url: string, correlationId?: string | undefined) => void;
}): OAuthChannel {
  const { channel, onSubmit } = options;

  return {
    onAuthRequired(n: AuthRequiredNotification): void {
      const text = buildAuthRequiredText(n);
      void channel.send({ content: [{ kind: "text", text }] }).catch((_err: unknown) => {
        console.error(
          `[oauth-channel] Failed to send auth_required message for provider: ${n.provider}`,
        );
      });
    },

    onAuthComplete(n: AuthCompleteNotification): void {
      const text = `${n.provider} authorization complete. Continuing...`;
      void channel.send({ content: [{ kind: "text", text }] }).catch((_err: unknown) => {
        // Swallow silently — auth already succeeded, UI glitch is non-critical
      });
    },

    submitAuthCode(redirectUrl: string, correlationId?: string | undefined): void {
      if (onSubmit !== undefined) {
        onSubmit(redirectUrl, correlationId);
      }
    },
  };
}
