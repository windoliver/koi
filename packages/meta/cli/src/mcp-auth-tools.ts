/**
 * MCP auth pseudo-tool factory — CLI implementation.
 *
 * Creates `{server}__authenticate` and `{server}__complete_authentication`
 * pseudo-tools for MCP servers that need OAuth. These tools appear in the
 * model's tool list so it can tell the user about auth requirements and
 * trigger the OAuth flow inline.
 *
 * Follows the Claude Code pattern: auth-needed servers get pseudo-tools
 * instead of being silently invisible.
 */

import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { AuthToolFactory, McpConnection, McpServerFailure, OAuthAuthProvider } from "@koi/mcp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-server entry bundling the deps the auth tools need. */
export interface AuthServerEntry {
  readonly provider: OAuthAuthProvider;
  readonly connection: McpConnection;
  readonly url: string;
}

export interface CliAuthToolFactoryOptions {
  /** Map from server name to its auth entry. */
  readonly servers: ReadonlyMap<string, AuthServerEntry>;
  /** Force a full re-discover so real tools replace pseudo-tools. */
  readonly rediscover: () => Promise<readonly unknown[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCliAuthToolFactory(options: CliAuthToolFactoryOptions): AuthToolFactory {
  const { servers, rediscover } = options;

  return (failure: McpServerFailure): readonly Tool[] => {
    const entry = servers.get(failure.serverName);
    if (entry === undefined) return [];

    return [createAuthenticateTool(failure.serverName, entry, rediscover)];
  };
}

// ---------------------------------------------------------------------------
// authenticate tool
// ---------------------------------------------------------------------------

function createAuthenticateTool(
  serverName: string,
  entry: AuthServerEntry,
  rediscover: () => Promise<readonly unknown[]>,
): Tool {
  // Never include server URL/hostname in the description — tool descriptors
  // are sent to the model/provider, and private MCP deployments must not
  // leak hostnames through auth pseudo-tools.
  const descriptor: ToolDescriptor = {
    name: `${serverName}__authenticate`,
    description:
      `The "${serverName}" MCP server requires authentication. ` +
      `Call this tool to start the OAuth flow — a browser window will open ` +
      `for the user to authorize access. After authentication succeeds, ` +
      `tokens are stored and the server's tools will load automatically.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    origin: "operator",
    server: serverName,
  };

  const execute = async (_args: JsonObject): Promise<unknown> => {
    const { triggerAuth } = entry.connection;
    if (triggerAuth === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              `Authentication is not available for "${serverName}". ` +
              `The server may not be configured for OAuth. Try: koi mcp auth ${serverName}`,
          },
        ],
        isError: true,
      };
    }

    // Route through triggerAuth() so concurrent auth attempts share the
    // singleflight and the onAuthComplete notification fires only once.
    const result = await triggerAuth();
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Authentication failed for "${serverName}": ${result.error.message}. ` +
              `The user can also try: koi mcp auth ${serverName}`,
          },
        ],
        isError: true,
      };
    }

    // Re-discover so the resolver replaces pseudo-tools with real server tools.
    await rediscover();

    return {
      content: [
        {
          type: "text",
          text:
            `Authentication successful for "${serverName}". ` +
            `Tokens are stored and the server has been reconnected. ` +
            `The server's tools are now available.`,
        },
      ],
    };
  };

  return { descriptor, origin: "operator", policy: DEFAULT_UNSANDBOXED_POLICY, execute };
}
