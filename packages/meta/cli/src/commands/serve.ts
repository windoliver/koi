/**
 * `koi serve` — boot a headless gateway server (createGatewayStack).
 *
 * Authentication is fail-closed by default. Without `--unsafe-dev-auth`,
 * the server refuses to start because the v2 CLI does not yet ship a
 * production GatewayAuthenticator (token verifier, JWT, etc.) — the
 * pluggable auth layer is owned by the remote/bridge work in #1412.
 *
 * `--unsafe-dev-auth` enables a permissive authenticator (any client can
 * claim any agentId). To prevent accidental internet exposure with that
 * mode active the server also refuses non-loopback binds and refuses to
 * write the resulting unauthenticated sessions into a shared Nexus
 * namespace.
 *
 * Health endpoint is exposed on a sibling HTTP server (port + 1).
 */

import { createBunTransport, type GatewayAuthenticator, type Transport } from "@koi/gateway";
import { createGatewayStack, type GatewayStack } from "@koi/gateway-stack";
import { createHttpTransport } from "@koi/nexus-client";
import type { ServeFlags } from "../args/serve.js";
import { ExitCode } from "../types.js";

const DEFAULT_PORT = 19500;

const LOOPBACK_HOSTNAME = "127.0.0.1";

export async function run(flags: ServeFlags): Promise<ExitCode> {
  const port = flags.port ?? DEFAULT_PORT;
  // Treat any --nexus-url as "intent to use Nexus" so the guard cannot be
  // bypassed by omitting --nexus-api-key.
  const wantsNexus = flags.nexusUrl !== undefined;
  const useNexus = flags.nexusUrl !== undefined && flags.nexusApiKey !== undefined;

  const guard = guardConfig(flags, wantsNexus);
  if (guard !== undefined) {
    process.stderr.write(`koi serve: ${guard}\n`);
    return ExitCode.FAILURE;
  }
  // (No separate "--nexus-url requires --nexus-api-key" branch: guardConfig
  // already refuses any combination of --unsafe-dev-auth + --nexus-url, and
  // --nexus-url WITHOUT --unsafe-dev-auth is refused by the auth-missing
  // branch above. Both pre-conditions for reaching this point imply
  // wantsNexus → useNexus has been satisfied.)

  const auth: GatewayAuthenticator = {
    authenticate: async (frame) => ({
      ok: true,
      sessionId: `sess-${crypto.randomUUID()}`,
      agentId: frame.client?.id ?? "default-agent",
      metadata: { unsafeDevAuth: true },
    }),
  };

  // Narrow at the boundary so the createHttpTransport call doesn't need
  // non-null assertions — useNexus already guarantees both flags are set
  // but TS can't track that across a const-derived flag.
  const nexusTransport =
    flags.nexusUrl !== undefined && flags.nexusApiKey !== undefined
      ? createHttpTransport({ url: flags.nexusUrl, apiKey: flags.nexusApiKey })
      : undefined;

  // unsafe-dev-auth must NEVER bind 0.0.0.0 — Bun.serve defaults to all
  // interfaces, which would expose a permissive authenticator to the
  // network. Force loopback when permissive auth is active.
  const stack: GatewayStack = createGatewayStack(
    {
      ...(useNexus ? { nexus: { instanceId: `koi-serve-${process.pid}` } } : {}),
    },
    {
      transport: createBunTransport({ hostname: LOOPBACK_HOSTNAME }) as Transport,
      auth,
      ...(nexusTransport !== undefined ? { nexusTransport } : {}),
    },
  );

  await stack.start(port);
  process.stdout.write(`koi serve: gateway listening on ws://${LOOPBACK_HOSTNAME}:${port}\n`);
  process.stdout.write(
    `koi serve: AUTH MODE = unsafe-dev-auth (any client can impersonate any agentId)\n`,
  );
  if (useNexus && flags.nexusUrl !== undefined) {
    process.stdout.write(`koi serve: HA mode — sessions persist to ${flags.nexusUrl}\n`);
  } else {
    process.stdout.write(`koi serve: standalone — sessions in-memory only\n`);
  }

  const healthServer = Bun.serve({
    port: port + 1,
    hostname: LOOPBACK_HOSTNAME,
    fetch: (req) => stack.healthHandler(req),
  });
  process.stdout.write(
    `koi serve: health endpoint at http://${LOOPBACK_HOSTNAME}:${healthServer.port}/health\n`,
  );

  let stopped = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.stdout.write(`\nkoi serve: ${signal} received, shutting down…\n`);
    healthServer.stop();
    await stack.stop();
    process.exit(ExitCode.OK);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => {});
  return ExitCode.OK;
}

/**
 * Pre-flight policy gate. Returns an error message if the flag combo is
 * unsafe; returns undefined when start is permitted. Kept pure so it is
 * trivially unit-testable.
 *
 * The second argument is `wantsNexus` (intent), not `useNexus` (fully wired)
 * — the guard must fire whenever --nexus-url is present, even if the API key
 * is missing, so a user cannot bypass the combo refusal by omitting one flag.
 */
export function guardConfig(flags: ServeFlags, wantsNexus: boolean): string | undefined {
  if (!flags.unsafeDevAuth) {
    return [
      "no production authenticator wired yet (#1412 owns JWT auth).",
      "Re-run with `--unsafe-dev-auth` for local-loopback dev only,",
      "or wait for the auth bridge to land.",
    ].join(" ");
  }
  if (wantsNexus) {
    return "refusing --unsafe-dev-auth combined with --nexus-url: permissive auth would write unauthenticated sessions into a shared Nexus namespace.";
  }
  return undefined;
}
