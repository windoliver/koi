/**
 * CLI implementation of OAuthRuntime.
 *
 * Handles the interactive parts of the OAuth flow:
 * - Opening the authorization URL in the user's browser
 * - Starting a local HTTP server to receive the callback
 * - Notifying the user when re-authentication is needed
 */

import { createServer, type Server } from "node:http";
import { parse } from "node:url";

// ---------------------------------------------------------------------------
// Types (mirrors @koi/mcp's OAuthRuntime without importing it)
// ---------------------------------------------------------------------------

interface OAuthCallbackResult {
  readonly code: string;
  readonly state: string | undefined;
}

interface OAuthRuntime {
  readonly authorize: (
    authorizationUrl: string,
    redirectUri: string,
  ) => Promise<OAuthCallbackResult>;
  readonly onReauthNeeded: (serverName: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCliOAuthRuntime(): OAuthRuntime {
  return {
    authorize: startCallbackServer,
    onReauthNeeded: async (serverName: string) => {
      console.log(
        `\nAuthentication expired for MCP server "${serverName}".` +
          `\nRun: koi mcp auth ${serverName}`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Browser + callback server
// ---------------------------------------------------------------------------

const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes

async function startCallbackServer(
  authorizationUrl: string,
  redirectUri: string,
): Promise<OAuthCallbackResult> {
  const uri = new URL(redirectUri);
  const port = Number(uri.port) || 8912;
  const callbackPath = uri.pathname;

  return new Promise<OAuthCallbackResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 2 minutes"));
    }, CALLBACK_TIMEOUT_MS);

    const server: Server = createServer((req, res) => {
      const parsed = parse(req.url ?? "", true);

      if (parsed.pathname !== callbackPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = parsed.query.code;
      const error = parsed.query.error;

      if (typeof error === "string") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h1>Authentication Failed</h1><p>You can close this tab.</p></body></html>",
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (typeof code !== "string") {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Missing Authorization Code</h1></body></html>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Authentication Successful</h1><p>You can close this tab and return to the terminal.</p></body></html>",
      );
      const callbackState = parsed.query.state;
      clearTimeout(timeout);
      server.close();
      resolve({
        code,
        state: typeof callbackState === "string" ? callbackState : undefined,
      });
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`\nOpening browser for authentication...`);
      console.log(`If the browser doesn't open, visit:\n  ${authorizationUrl}\n`);
      openBrowser(authorizationUrl);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start callback server on port ${port}: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Browser opener (cross-platform)
// ---------------------------------------------------------------------------

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url];

  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // Best-effort — user has the URL in the console
  }
}
