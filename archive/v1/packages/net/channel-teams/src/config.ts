/**
 * Configuration types for @koi/channel-teams.
 */

import type { ChannelAdapter, InboundMessage } from "@koi/core";
import type { TeamsConversationReference } from "./activity-types.js";

/** Feature toggles for the Teams channel. */
export interface TeamsFeatures {
  /** Enable Adaptive Cards support. Default: false */
  readonly adaptiveCards?: boolean;
  /** Enable task modules. Default: false */
  readonly taskModules?: boolean;
  /** Enable messaging extensions. Default: false */
  readonly messagingExtensions?: boolean;
}

/** Configuration for the Teams channel adapter. */
export interface TeamsChannelConfig {
  /** Azure AD application ID. */
  readonly appId: string;
  /** Azure AD application password. */
  readonly appPassword: string;
  /** Single-tenant Azure AD tenant ID. */
  readonly tenantId?: string;
  /** HTTP webhook endpoint port. Default: 3978 */
  readonly port?: number;
  /** Feature toggles. */
  readonly features?: TeamsFeatures;
  /** Error handler for message processing failures. */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /** Queue outbound messages when disconnected. Default: false */
  readonly queueWhenDisconnected?: boolean;
  /** @internal Test injection for agent/turn context. */
  readonly _agent?: unknown;
}

/** Extended adapter with Teams-specific capabilities. */
export interface TeamsChannelAdapter extends ChannelAdapter {
  /** Handle raw Bot Framework Activity. For custom HTTP integration. */
  readonly handleActivity?: (activity: unknown) => Promise<void>;
  /** Stored conversation references for proactive messaging (OpenClaw pattern). */
  readonly conversationReferences: () => ReadonlyMap<string, TeamsConversationReference>;
}

/** Default HTTP port for Teams webhook. */
export const DEFAULT_TEAMS_PORT = 3978;
