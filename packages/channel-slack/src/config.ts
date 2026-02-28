/**
 * Configuration types for the Slack channel adapter.
 */

import type { InboundMessage } from "@koi/core";

/**
 * Slack deployment mode.
 *
 * - "socket": Uses Slack Socket Mode (WebSocket) — requires an App-Level Token.
 * - "http": Uses Slack Events API over HTTP — requires a Signing Secret.
 */
export type SlackDeployment =
  | { readonly mode: "socket"; readonly appToken: string }
  | { readonly mode: "http"; readonly signingSecret: string; readonly port?: number };

/**
 * Controls how the bot replies in Slack threads.
 *
 * - "off": Never reply in threads (always post to channel).
 * - "first": Only reply in thread if the bot was mentioned in the first message.
 * - "all": Reply in thread whenever the original message is in a thread.
 *
 * Default: "all".
 */
export type SlackReplyToMode = "off" | "first" | "all";

/**
 * Optional feature flags for the Slack channel.
 * All default to true when omitted.
 */
export interface SlackFeatures {
  readonly threads?: boolean;
  readonly slashCommands?: boolean;
  readonly reactions?: boolean;
  readonly files?: boolean;
  /** Controls thread reply behavior. Default: "all". */
  readonly replyToMode?: SlackReplyToMode;
}

/** Configuration for the Slack channel adapter. */
export interface SlackChannelConfig {
  readonly botToken: string;
  readonly deployment: SlackDeployment;
  readonly features?: SlackFeatures;
  /** Maximum media attachment size in MB. Oversized media triggers text fallback. */
  readonly mediaMaxMb?: number;
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  readonly queueWhenDisconnected?: boolean;
  /** Test injection: Slack WebClient instance. */
  readonly _webClient?: unknown;
  /** Test injection: Slack SocketModeClient instance. */
  readonly _socketClient?: unknown;
}

/** Resolved features with all defaults applied. */
export interface ResolvedSlackFeatures {
  readonly threads: boolean;
  readonly slashCommands: boolean;
  readonly reactions: boolean;
  readonly files: boolean;
  readonly replyToMode: SlackReplyToMode;
}

/** Resolves feature flags with defaults (all true, replyToMode "all"). */
export function resolveFeatures(features?: SlackFeatures): ResolvedSlackFeatures {
  return {
    threads: features?.threads ?? true,
    slashCommands: features?.slashCommands ?? true,
    reactions: features?.reactions ?? true,
    files: features?.files ?? true,
    replyToMode: features?.replyToMode ?? "all",
  };
}
