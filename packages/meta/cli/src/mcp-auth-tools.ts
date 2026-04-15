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

    return [
      createAuthenticateTool(failure.serverName, entry, rediscover),
      createCompleteAuthTool(failure.serverName),
    ];
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
  const descriptor: ToolDescriptor = {
    name: `${serverName}__authenticate`,
    description:
      `The "${serverName}" MCP server (http at ${entry.url}) requires authentication. ` +
      `Call this tool to start the OAuth flow — a browser window will open ` +
      `for the user to authorize access. After authentication, the server's ` +
      `real tools will become available.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    origin: "operator",
    server: serverName,
  };

  const execute = async (_args: JsonObject): Promise<unknown> => {
    const success = await entry.provider.startAuthFlow();
    if (!success) {
      return {
        content: [
          {
            type: "text",
            text:
              `Authentication failed for "${serverName}". The OAuth flow ` +
              `did not complete — the user may not have authorized in time, ` +
              `or the authorization server could not be reached. ` +
              `The user can also try: koi mcp auth ${serverName}`,
          },
        ],
        isError: true,
      };
    }

    // Reconnect now that tokens are stored
    const connectResult = await entry.connection.connect();
    if (!connectResult.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Authentication succeeded for "${serverName}" but reconnection ` +
              `failed: ${connectResult.error.message}. The server's tools ` +
              `should appear on the next turn.`,
          },
        ],
      };
    }

    // Re-discover so the resolver picks up real tools from the now-connected server
    await rediscover();

    return {
      content: [
        {
          type: "text",
          text:
            `Authentication successful for "${serverName}". ` +
            `The server's tools are now available.`,
        },
      ],
    };
  };

  return { descriptor, origin: "operator", policy: DEFAULT_UNSANDBOXED_POLICY, execute };
}

// ---------------------------------------------------------------------------
// complete_authentication tool (remote session support)
// ---------------------------------------------------------------------------

function createCompleteAuthTool(serverName: string): Tool {
  const descriptor: ToolDescriptor = {
    name: `${serverName}__complete_authentication`,
    description:
      `Complete an in-progress OAuth flow for the "${serverName}" MCP server ` +
      `by submitting the callback URL. Call ${serverName}__authenticate first ` +
      `to start the flow. After the user authorizes in their browser, the ` +
      `browser redirects to a http://localhost:<port>/callback?code=...&state=... ` +
      `URL — on remote sessions that page may fail to load, but the URL in ` +
      `the address bar is still valid. Pass that full URL here as callback_url.`,
    inputSchema: {
      type: "object",
      properties: {
        callback_url: {
          type: "string",
          description:
            "The full callback URL from the browser address bar after authorizing, " +
            "e.g. http://localhost:8912/callback?code=...&state=...",
        },
      },
      required: ["callback_url"],
      additionalProperties: false,
    },
    origin: "operator",
    server: serverName,
  };

  const execute = async (_args: JsonObject): Promise<unknown> => {
    // Phase 1 stub — full implementation requires extending OAuthRuntime
    // with a manual callback URL handler.
    return {
      content: [
        {
          type: "text",
          text:
            `Manual callback URL handling is not yet supported in this session. ` +
            `Please run "koi mcp auth ${serverName}" in a separate terminal ` +
            `to authenticate.`,
        },
      ],
      isError: true,
    };
  };

  return { descriptor, origin: "operator", policy: DEFAULT_UNSANDBOXED_POLICY, execute };
}
