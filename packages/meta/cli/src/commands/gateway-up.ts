import type { GatewayUpFlags } from "../args/gateway-up.js";
import type { ExitCode as ExitCodeValue } from "../types.js";
import { ExitCode } from "../types.js";

const DEFAULT_PORT = 19_500;

interface LauncherStartEvent {
  readonly kind: "gateway_up_started";
  readonly instanceId: string;
  readonly ws: string;
  readonly health: string;
  readonly nexus: string | null;
}

interface LocalGatewayLauncherModule {
  readonly createLocalGatewayLauncher: () => {
    readonly start: (config: {
      readonly port: number;
      readonly hostname?: string;
      readonly nexusUrl?: string;
      readonly nexusApiKey?: string;
      readonly instanceId?: string;
    }) => Promise<{
      readonly started: LauncherStartEvent;
      readonly stop: (signal: string) => Promise<unknown>;
    }>;
  };
}

export async function run(flags: GatewayUpFlags): Promise<ExitCodeValue> {
  try {
    const { createLocalGatewayLauncher } = await importGatewayLauncher();
    const launcher = createLocalGatewayLauncher();
    const started = await launcher.start({
      port: flags.port ?? DEFAULT_PORT,
      hostname: "127.0.0.1",
      nexusUrl: flags.nexusUrl,
      nexusApiKey: flags.nexusApiKey,
      instanceId: flags.instanceId,
    });

    writeStarted(flags, started.started);
    const signal = await waitForShutdownSignal();
    writeStopping(flags, signal);
    await started.stop(signal);
    writeStopped(flags, signal);
    return ExitCode.OK;
  } catch (err: unknown) {
    process.stderr.write(`koi gateway-up: ${formatUnknownError(err)}\n`);
    return ExitCode.FAILURE;
  }
}

async function importGatewayLauncher(): Promise<LocalGatewayLauncherModule> {
  return (await import(
    new URL("../../../../net/gateway-stack/src/index.ts", import.meta.url).href
  )) as LocalGatewayLauncherModule;
}

function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (signal: string): void => {
      if (resolved) return;
      resolved = true;
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      resolve(signal);
    };
    const onSigint = (): void => finish("SIGINT");
    const onSigterm = (): void => finish("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}

function writeStarted(flags: GatewayUpFlags, event: LauncherStartEvent): void {
  if (flags.logFormat === "json") {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  process.stderr.write(
    `koi gateway-up: listening on ${event.ws} (health ${event.health}, instance ${event.instanceId})\n`,
  );
  if (event.nexus !== null) {
    process.stderr.write(`koi gateway-up: Nexus ${event.nexus}\n`);
  }
}

function writeStopping(flags: GatewayUpFlags, signal: string): void {
  if (flags.logFormat === "json") {
    process.stdout.write(`${JSON.stringify({ kind: "gateway_up_stopping", signal })}\n`);
    return;
  }
  process.stderr.write(`koi gateway-up: stopping (${signal})\n`);
}

function writeStopped(flags: GatewayUpFlags, signal: string): void {
  if (flags.logFormat === "json") {
    process.stdout.write(`${JSON.stringify({ kind: "gateway_up_stopped", signal })}\n`);
    return;
  }
  process.stderr.write(`koi gateway-up: stopped (${signal})\n`);
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
