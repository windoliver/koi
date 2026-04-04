/**
 * Channel wiring for bridge auth notifications.
 *
 * Converts BridgeNotification events from transport.subscribe() into
 * user-facing channel messages during inline OAuth flows.
 *
 * Usage:
 *   const transport = await createLocalTransport({ mountUri: "gdrive://my-drive" });
 *   const unsubscribe = transport.subscribe(createAuthNotificationHandler(channel));
 *   const backend = createNexusFileSystem({ transport, url: "local://unused" });
 *   // call unsubscribe() when the transport is closed
 */

import type { ChannelAdapter } from "@koi/core";
import type { BridgeNotification } from "./types.js";

/**
 * Creates a BridgeNotification handler that sends user-facing messages to a
 * channel when OAuth authorization is required, in progress, or complete.
 *
 * Wire the returned function to `transport.subscribe()`:
 *
 *   const unsubscribe = transport.subscribe(createAuthNotificationHandler(channel));
 *
 * The handler is non-blocking — channel.send() is fire-and-forget via void.
 * Errors from channel.send() are swallowed to avoid breaking the reader loop.
 */
export function createAuthNotificationHandler(
  channel: ChannelAdapter,
): (n: BridgeNotification) => void {
  return (n: BridgeNotification): void => {
    if (n.method === "auth_required") {
      const { provider, auth_url, message } = n.params;
      void channel
        .send({
          content: [
            {
              kind: "text",
              text: `**${message}**\n\nOpen this link in your browser to authorize ${provider}:\n${auth_url}`,
            },
          ],
        })
        .catch((err: unknown) => {
          // auth_required delivery failure means the user never sees the OAuth URL.
          // Log prominently — the bridge will continue polling until auth_timeout,
          // then return AUTH_REQUIRED. This makes the root cause diagnosable.
          // eslint-disable-next-line no-console
          console.error(
            `[koi/fs-nexus] Failed to deliver auth_required for ${provider}: ${String(err)}. ` +
              `User will not see the authorization link at ${auth_url}`,
          );
        });
    } else if (n.method === "auth_progress") {
      const { message, elapsed_seconds } = n.params;
      void channel
        .send({
          content: [
            {
              kind: "text",
              text: `${message} (${String(elapsed_seconds)}s elapsed)`,
            },
          ],
        })
        .catch(() => {
          // Progress heartbeats are informational — delivery failure is not critical
        });
    } else if (n.method === "auth_complete") {
      const { provider } = n.params;
      void channel
        .send({
          content: [
            {
              kind: "text",
              text: `${provider} authorization complete. Continuing...`,
            },
          ],
        })
        .catch(() => {
          // Completion notice — decorative; operation will succeed regardless
        });
    }
  };
}
