/**
 * Configuration types and validation for @koi/channel-chat-sdk.
 *
 * Each platform uses a discriminated union on the `platform` field.
 * Credentials are optional — the Chat SDK adapters auto-detect from
 * environment variables when not provided explicitly.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

const VALID_PLATFORMS = ["slack", "discord", "teams", "gchat", "github", "linear"] as const;

export type PlatformName = (typeof VALID_PLATFORMS)[number];

export interface SlackPlatformConfig {
  readonly platform: "slack";
  readonly botToken?: string;
  readonly signingSecret?: string;
}

export interface DiscordPlatformConfig {
  readonly platform: "discord";
  readonly botToken?: string;
  readonly publicKey?: string;
  readonly applicationId?: string;
}

export interface TeamsPlatformConfig {
  readonly platform: "teams";
  readonly appId?: string;
  readonly appPassword?: string;
}

export interface GchatPlatformConfig {
  readonly platform: "gchat";
  readonly credentials?: {
    readonly client_email: string;
    readonly private_key: string;
    readonly project_id?: string;
  };
}

export interface GithubPlatformConfig {
  readonly platform: "github";
  readonly token?: string;
  readonly webhookSecret?: string;
  readonly userName?: string;
}

export interface LinearPlatformConfig {
  readonly platform: "linear";
  readonly apiKey?: string;
  readonly webhookSecret?: string;
  readonly userName?: string;
}

export type PlatformConfig =
  | SlackPlatformConfig
  | DiscordPlatformConfig
  | TeamsPlatformConfig
  | GchatPlatformConfig
  | GithubPlatformConfig
  | LinearPlatformConfig;

export interface ChatSdkChannelConfig {
  readonly platforms: readonly PlatformConfig[];
  readonly userName?: string;
}

function isPlatformName(value: unknown): value is PlatformName {
  return typeof value === "string" && VALID_PLATFORMS.includes(value as PlatformName);
}

export function validateChatSdkChannelConfig(
  input: unknown,
): Result<ChatSdkChannelConfig, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Chat SDK channel config must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const raw = input as Readonly<Record<string, unknown>>;

  if (!Array.isArray(raw.platforms)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Chat SDK channel config requires a 'platforms' array",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (raw.platforms.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Chat SDK channel config requires at least one platform",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const seen = new Set<string>();
  for (const entry of raw.platforms) {
    if (entry === null || entry === undefined || typeof entry !== "object") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Each platform entry must be an object with a 'platform' field",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    const platformEntry = entry as Readonly<Record<string, unknown>>;
    const platform = platformEntry.platform;

    if (!isPlatformName(platform)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Unknown platform: "${String(platform)}". Valid platforms: ${VALID_PLATFORMS.join(", ")}`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    if (seen.has(platform)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Duplicate platform "${platform}" — each platform may only appear once`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    seen.add(platform);
  }

  const config: ChatSdkChannelConfig = {
    platforms: raw.platforms as readonly PlatformConfig[],
    ...(typeof raw.userName === "string" ? { userName: raw.userName } : {}),
  };

  return { ok: true, value: config };
}
