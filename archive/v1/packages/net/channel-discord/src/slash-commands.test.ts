/**
 * Unit tests for slash command registration.
 */

import { describe, expect, test } from "bun:test";
import type { DiscordSlashCommand } from "./slash-commands.js";

describe("DiscordSlashCommand types", () => {
  test("command with no options is valid", () => {
    const cmd: DiscordSlashCommand = {
      name: "ping",
      description: "Check bot latency",
    };
    expect(cmd.name).toBe("ping");
    expect(cmd.description).toBe("Check bot latency");
    expect(cmd.options).toBeUndefined();
  });

  test("command with options is valid", () => {
    const cmd: DiscordSlashCommand = {
      name: "search",
      description: "Search for something",
      options: [
        {
          name: "query",
          description: "Search query",
          type: 3, // STRING
          required: true,
        },
      ],
    };
    expect(cmd.options).toHaveLength(1);
    expect(cmd.options?.[0]?.name).toBe("query");
  });

  test("command option with choices is valid", () => {
    const cmd: DiscordSlashCommand = {
      name: "color",
      description: "Pick a color",
      options: [
        {
          name: "color",
          description: "The color to pick",
          type: 3,
          choices: [
            { name: "Red", value: "red" },
            { name: "Blue", value: "blue" },
          ],
        },
      ],
    };
    expect(cmd.options?.[0]?.choices).toHaveLength(2);
  });
});

// registerCommands() itself requires REST API mocking — tested via integration
// with the descriptor factory test using config injection.
