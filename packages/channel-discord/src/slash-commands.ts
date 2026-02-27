/**
 * Discord slash command registration.
 *
 * Uses the Discord REST API to register global application commands.
 * Commands are replaced in bulk (idempotent — safe to call on every startup).
 */

import { REST, Routes } from "discord.js";

/** A slash command definition for registration. */
export interface DiscordSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly DiscordCommandOption[];
}

/** A single command option (string, integer, boolean, etc.). */
export interface DiscordCommandOption {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly required?: boolean;
  readonly choices?: readonly { readonly name: string; readonly value: string | number }[];
}

/**
 * Registers global slash commands for the application.
 * Replaces ALL existing global commands (idempotent).
 *
 * @param token - The bot token for REST API authentication.
 * @param applicationId - The Discord application ID.
 * @param commands - The commands to register.
 */
export async function registerCommands(
  token: string,
  applicationId: string,
  commands: readonly DiscordSlashCommand[],
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), {
    body: commands,
  });
}
