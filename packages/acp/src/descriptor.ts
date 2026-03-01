/**
 * BrickDescriptor for @koi/acp.
 *
 * Enables manifest-based auto-resolution for the ACP server channel.
 * No required options — the channel operates from the current process.
 */

import type { ChannelAdapter, CompanionSkillDefinition, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { createAcpChannel } from "./acp-channel.js";
import type { AcpServerConfig } from "./types.js";

const ACP_SERVER_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "acp-server-guide",
  description: "When to use channel: acp",
  tags: ["channel", "acp", "ide", "json-rpc", "server"],
  content: `# Channel: acp (server)

## When to use
- Making a Koi agent consumable by IDEs (JetBrains, Zed, VS Code)
- Serving an agent via ACP (Agent Client Protocol) over stdin/stdout
- When the IDE spawns Koi as a subprocess

## Manifest example
\`\`\`yaml
channel:
  name: acp-server
  options:
    agentInfo:
      name: "my-agent"
      version: "1.0.0"
\`\`\`

## Optional options
- \`agentInfo\` (object): name, title, version reported to the IDE
- \`agentCapabilities\` (object): ACP capabilities to advertise
- \`timeouts\` (object): per-request timeout overrides

## When NOT to use
- For outbound ACP client connections (use \`engine: acp\` instead)
- For HTTP/WebSocket channels (use \`channel-chat-sdk\` etc.)
`,
};

function validateAcpServerOptions(input: unknown): Result<unknown, KoiError> {
  // No required options — all are optional
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ACP server options must be an object (or omitted entirely)",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for the ACP server channel.
 * Registered under the name "@koi/acp" with alias "acp-server".
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/acp",
  aliases: ["acp-server"],
  description: "ACP protocol server channel for IDE integration",
  tags: ["acp", "ide", "channel", "json-rpc"],
  companionSkills: [ACP_SERVER_COMPANION_SKILL],
  optionsValidator: validateAcpServerOptions,
  factory(options: Record<string, unknown>, _context: ResolutionContext): ChannelAdapter {
    const config: AcpServerConfig = {
      ...(typeof options === "object" && options !== null ? (options as AcpServerConfig) : {}),
    };
    return createAcpChannel(config);
  },
};
