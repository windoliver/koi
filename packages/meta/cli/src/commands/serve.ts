import type { ApprovalHandler, EngineEvent, InboundMessage, JsonObject } from "@koi/core";
import type {
  ChannelRegistration,
  Gateway,
  GatewayFrame,
  GatewayServer,
  Session,
} from "@koi/gateway-http";
import { createGatewayServer } from "@koi/gateway-http";
import { createPatternPermissionBackend } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import type { ServeFlags } from "../args/serve.js";
import { resolveApiConfig } from "../env.js";
import { loadManifestConfig } from "../manifest.js";
import type { KoiRuntimeHandle } from "../runtime-factory.js";
import {
  resolveServiceConfig,
  type ServiceConfig,
  serviceHealthUrl,
} from "../service-lifecycle.js";
import { ExitCode } from "../types.js";

export interface ServeDeps {
  readonly waitForShutdownSignal?: (() => Promise<string>) | undefined;
  readonly createRuntime?: (
    service: ServiceConfig,
    flags: ServeFlags,
  ) => Promise<ServeRuntimeHandle>;
}

interface ServeRuntimeHandle {
  readonly runtime: Pick<KoiRuntimeHandle["runtime"], "run" | "dispose">;
  readonly shutdownBackgroundTasks: KoiRuntimeHandle["shutdownBackgroundTasks"];
}

const autoApproveHandler: ApprovalHandler = async () => ({
  kind: "always-allow",
  scope: "session",
});

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

  let runtimeHandle: ServeRuntimeHandle | undefined;
  try {
    runtimeHandle = await (deps?.createRuntime ?? createServeRuntime)(resolved.value, flags);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`koi serve: runtime assembly failed - ${message}\n`);
    return ExitCode.FAILURE;
  }

  const gateway = createRuntimeGateway(runtimeHandle.runtime, flags.verbose);
  const server = createGatewayServer(
    {
      bind: `127.0.0.1:${resolved.value.port}`,
      lockFilePath: resolved.value.lockFilePath,
    },
    { gateway },
  );

  const channel = registerEnvGatewayChannel(server, resolved.value);
  if (!channel.ok) {
    process.stderr.write(`koi serve: ${channel.error}\n`);
    await disposeRuntime(runtimeHandle, flags);
    return ExitCode.FAILURE;
  }

  try {
    const started = await server.start();
    if (!started.ok) {
      process.stderr.write(`koi serve: ${started.error.message}\n`);
      await disposeRuntime(runtimeHandle, flags);
      return ExitCode.FAILURE;
    }
  } catch (err: unknown) {
    process.stderr.write(`koi serve: gateway start failed - ${formatUnknownError(err)}\n`);
    await disposeRuntime(runtimeHandle, flags);
    return ExitCode.FAILURE;
  }

  writeServeEvent(flags, {
    kind: "serve_started",
    service: resolved.value.serviceName,
    channel: channel.value,
    health: serviceHealthUrl(resolved.value),
    manifest: resolved.value.manifestPath,
    port: server.port(),
  });

  const waitForShutdownSignal = deps?.waitForShutdownSignal ?? defaultWaitForShutdownSignal;
  let signal: string;
  try {
    signal = await waitForShutdownSignal();
  } catch (err: unknown) {
    process.stderr.write(`koi serve: shutdown wait failed - ${formatUnknownError(err)}\n`);
    await stopGatewayServer(server);
    await disposeRuntime(runtimeHandle, flags);
    return ExitCode.FAILURE;
  }
  const stopped = await stopGatewayServer(server);
  await disposeRuntime(runtimeHandle, flags);

  writeServeEvent(flags, {
    kind: "serve_stopped",
    service: resolved.value.serviceName,
    signal,
  });
  return stopped ? ExitCode.OK : ExitCode.FAILURE;
}

async function createServeRuntime(
  service: ServiceConfig,
  _flags: ServeFlags,
): Promise<KoiRuntimeHandle> {
  const manifestResult = await loadManifestConfig(service.manifestPath, {
    skipAuditValidation: true,
  });
  if (!manifestResult.ok) {
    throw new Error(`invalid manifest - ${manifestResult.error}`);
  }

  const apiConfigResult = resolveApiConfig();
  if (!apiConfigResult.ok) throw new Error(apiConfigResult.error);
  const apiConfig = apiConfigResult.value;
  const model = manifestResult.value.modelName ?? apiConfig.model;
  const { createKoiRuntime } = await import("../runtime-factory.js");

  return createKoiRuntime({
    modelAdapter: createOpenAICompatAdapter({
      apiKey: apiConfig.apiKey,
      ...(apiConfig.baseUrl !== undefined ? { baseUrl: apiConfig.baseUrl } : {}),
      model,
    }),
    modelName: model,
    approvalHandler: autoApproveHandler,
    cwd: service.workDir,
    engineId: "koi-serve",
    hostId: "koi-serve",
    workspaceOnlyFs: true,
    permissionBackend: createPatternPermissionBackend({
      rules: { allow: ["*"], deny: [], ask: [] },
    }),
    permissionsDescription: "koi serve - auto-allow",
    defaultMaxDurationMs: 300_000,
    backgroundSubprocesses: false,
    ...(manifestResult.value.instructions !== undefined
      ? { systemPrompt: manifestResult.value.instructions }
      : {}),
    ...(manifestResult.value.stacks !== undefined ? { stacks: manifestResult.value.stacks } : {}),
    ...(manifestResult.value.plugins !== undefined
      ? { plugins: manifestResult.value.plugins }
      : { plugins: [] }),
    ...(manifestResult.value.middleware !== undefined
      ? { manifestMiddleware: manifestResult.value.middleware }
      : {}),
  });
}

function createRuntimeGateway(
  runtime: Pick<KoiRuntimeHandle["runtime"], "run">,
  verbose: boolean,
): Gateway {
  let queue: Promise<void> = Promise.resolve();
  let paused = false;
  return {
    ingest(session: Session, frame: GatewayFrame): Promise<void> {
      if (paused) throw new Error("gateway is draining");
      const next = queue.then(() => runFrame(runtime, session, frame, verbose));
      queue = next.catch(() => undefined);
      return next;
    },
    pauseIngress(): void {
      paused = true;
    },
    forceClose(): void {
      paused = true;
    },
    activeConnections(): number {
      return 0;
    },
  };
}

async function runFrame(
  runtime: Pick<KoiRuntimeHandle["runtime"], "run">,
  session: Session,
  frame: GatewayFrame,
  verbose: boolean,
): Promise<void> {
  const message = inboundMessageFromFrame(session, frame);
  let sawDone = false;
  let terminal: Extract<EngineEvent, { kind: "done" }> | undefined;
  for await (const event of runtime.run({ kind: "messages", messages: [message] })) {
    if (verbose && event.kind === "text_delta" && event.delta.length > 0) {
      process.stderr.write(event.delta);
    }
    if (event.kind === "done") {
      sawDone = true;
      terminal = event;
    }
  }
  if (!sawDone) throw new Error(`gateway frame ${frame.id} ended without a done event`);
  if (terminal?.output.stopReason === "error") {
    throw new Error(`gateway frame ${frame.id} failed in runtime`);
  }
}

function inboundMessageFromFrame(session: Session, frame: GatewayFrame): InboundMessage {
  return {
    senderId: session.agentId,
    threadId: session.id,
    timestamp: frame.timestamp,
    content: [{ kind: "text", text: extractPrompt(frame.payload) }],
    metadata: {
      source: "gateway-http",
      frameId: frame.id,
      frameKind: frame.kind,
      routing: session.routing,
      sessionMetadata: session.metadata,
    } satisfies JsonObject,
  };
}

function extractPrompt(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object" || payload === null) return JSON.stringify(payload);
  const rec = payload as Record<string, unknown>;
  for (const key of ["text", "message", "prompt", "content"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const blocks = rec.content;
  if (Array.isArray(blocks)) {
    const text = blocks
      .map((block) => {
        if (typeof block !== "object" || block === null) return "";
        const candidate = (block as Record<string, unknown>).text;
        return typeof candidate === "string" ? candidate : "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
    if (text.length > 0) return text;
  }
  return JSON.stringify(payload);
}

function registerEnvGatewayChannel(
  server: {
    readonly registerChannel: (
      reg: ChannelRegistration,
    ) => { ok: true } | { ok: false; error: { message: string } };
  },
  service: ServiceConfig,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  const secret = process.env.KOI_GATEWAY_SECRET;
  if (secret === undefined || secret.length === 0) {
    return {
      ok: false,
      error:
        "KOI_GATEWAY_SECRET is required so HTTP ingress can authenticate and route events to the runtime",
    };
  }
  const channelId = process.env.KOI_GATEWAY_CHANNEL ?? "koi";
  const result = server.registerChannel({
    id: channelId,
    secret,
    replayProtection: process.env.KOI_GATEWAY_REPLAY === "nonce" ? "nonce" : "timestamp-only",
    authenticate: async (_req, _rawBody, payload) => {
      const rec =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      return {
        ok: true,
        value: {
          agentId: envString("KOI_GATEWAY_AGENT_ID") ?? service.serviceName,
          tenantId:
            stringValue(rec.tenantId) ??
            stringValue(rec.team_id) ??
            stringValue(rec.account) ??
            "default",
          metadata: {
            channelId,
            ...(stringValue(rec.sessionId) !== undefined
              ? { sessionId: stringValue(rec.sessionId) }
              : {}),
          } satisfies JsonObject,
        },
      };
    },
    resolveSession: async (_req, outcome) =>
      stringValue(outcome.metadata?.sessionId) ?? stringValue(outcome.routing?.peer) ?? "create",
    extractDeliveryId: (_req, payload) => {
      const rec =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      return (
        stringValue(rec.deliveryId) ?? stringValue(rec.event_id) ?? stringValue(rec.id) ?? undefined
      );
    },
  });
  if (!result.ok) return { ok: false, error: result.error.message };
  return { ok: true, value: channelId };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

async function disposeRuntime(runtimeHandle: ServeRuntimeHandle, flags: ServeFlags): Promise<void> {
  try {
    const hadLiveWork = runtimeHandle.shutdownBackgroundTasks();
    if (hadLiveWork) await new Promise<void>((resolve) => setTimeout(resolve, 3_700));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`koi serve: shutdownBackgroundTasks failed - ${message}\n`);
  }
  try {
    await runtimeHandle.runtime.dispose?.();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`koi serve: runtime.dispose failed - ${message}\n`);
  }
  if (flags.verbose) process.stderr.write("koi serve: runtime disposed\n");
}

async function stopGatewayServer(server: Pick<GatewayServer, "stop">): Promise<boolean> {
  try {
    await server.stop();
    return true;
  } catch (err: unknown) {
    process.stderr.write(`koi serve: gateway stop failed - ${formatUnknownError(err)}\n`);
    return false;
  }
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      `koi serve: ${String(event.service)} listening on ${String(event.health)} ` +
        `(channel ${String(event.channel)})\n`,
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
