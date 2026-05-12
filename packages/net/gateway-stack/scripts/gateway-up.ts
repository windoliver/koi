#!/usr/bin/env bun
/**
 * Standalone gateway-stack runner for E2E tmux validation.
 *
 * Thin wrapper over the shared local launcher so the CLI command and the
 * legacy script share identical loopback startup/shutdown behavior.
 */

import { createLocalGatewayLauncher } from "../src/index.js";

try {
  const launcher = createLocalGatewayLauncher();
  const started = await launcher.start({
    port: Number.parseInt(process.env.PORT ?? "19500", 10),
    hostname: "127.0.0.1",
    nexusUrl: process.env.NEXUS_URL,
    nexusApiKey: process.env.NEXUS_API_KEY,
    instanceId: process.env.INSTANCE_ID,
  });

  console.log(JSON.stringify(started.started));

  let stopped = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    console.log(JSON.stringify({ kind: "gateway_up_stopping", signal }));
    await started.stop(signal);
    console.log(JSON.stringify({ kind: "gateway_up_stopped" }));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => {});
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
