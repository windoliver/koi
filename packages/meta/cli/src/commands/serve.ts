import type { Gateway, GatewayFrame, Session } from "@koi/gateway-http";
import { createGatewayServer } from "@koi/gateway-http";
import type { ServeFlags } from "../args/serve.js";
import {
  resolveServiceConfig,
  serviceHealthUrl,
  validateServiceManifest,
} from "../service-lifecycle.js";
import { ExitCode } from "../types.js";

export interface ServeDeps {
  readonly waitForShutdownSignal?: (() => Promise<string>) | undefined;
}

export async function run(flags: ServeFlags, deps?: ServeDeps): Promise<ExitCode> {
  const resolved = await resolveServiceConfig({
    manifest: flags.manifest,
    port: flags.port,
    system: undefined,
  });
  if (!resolved.ok) {
    process.stderr.write(`koi serve: ${resolved.error}\n`);
    return ExitCode.FAILURE;
  }

  const validation = await validateServiceManifest(resolved.value.manifestPath);
  if (!validation.ok) {
    process.stderr.write(`koi serve: ${validation.error}\n`);
    return ExitCode.FAILURE;
  }

  const server = createGatewayServer(
    {
      bind: `127.0.0.1:${resolved.value.port}`,
      lockFilePath: resolved.value.lockFilePath,
    },
    { gateway: createLoggingGateway(flags.verbose) },
  );

  const started = await server.start();
  if (!started.ok) {
    process.stderr.write(`koi serve: ${started.error.message}\n`);
    return ExitCode.FAILURE;
  }

  writeServeEvent(flags, {
    kind: "serve_started",
    service: resolved.value.serviceName,
    health: serviceHealthUrl(resolved.value),
    manifest: resolved.value.manifestPath,
    port: server.port(),
  });

  const waitForShutdownSignal = deps?.waitForShutdownSignal ?? defaultWaitForShutdownSignal;
  const signal = await waitForShutdownSignal();
  await server.stop();

  writeServeEvent(flags, {
    kind: "serve_stopped",
    service: resolved.value.serviceName,
    signal,
  });
  return ExitCode.OK;
}

function createLoggingGateway(verbose: boolean): Gateway {
  return {
    ingest(session: Session, frame: GatewayFrame): void {
      if (!verbose) return;
      process.stderr.write(
        `[gateway] ${session.agentId}/${session.id} ${frame.kind} ${frame.id}\n`,
      );
    },
    pauseIngress(): void {
      // No external WS transport is attached in CLI service mode.
    },
    forceClose(): void {
      // No external WS transport is attached in CLI service mode.
    },
    activeConnections(): number {
      return 0;
    },
  };
}

function writeServeEvent(
  flags: ServeFlags,
  event: Readonly<Record<string, string | number>>,
): void {
  if (flags.logFormat === "json") {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.kind === "serve_started") {
    process.stderr.write(
      `koi serve: ${String(event.service)} listening on ${String(event.health)}\n`,
    );
    return;
  }
  process.stderr.write(`koi serve: ${String(event.service)} stopped (${String(event.signal)})\n`);
}

function defaultWaitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    let onSigint: () => void;
    let onSigterm: () => void;
    const cleanup = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    onSigint = (): void => {
      cleanup();
      resolve("SIGINT");
    };
    onSigterm = (): void => {
      cleanup();
      resolve("SIGTERM");
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}
