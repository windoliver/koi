import type { ApprovalHandler, EngineEvent, InboundMessage, JsonObject } from "@koi/core";
import { createPatternPermissionBackend } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import type {
  ChannelRegistration,
  Gateway,
  GatewayFrame,
  GatewayServer,
  Session,
} from "@koi/runtime";
import type { ServeFlags } from "../args/serve.js";
import { resolveApiConfig } from "../env.js";
import type { ManifestConfig } from "../manifest.js";
import type { KoiRuntimeHandle } from "../runtime-factory.js";
import {
  resolveServiceConfig,
  type ServiceConfig,
  serviceHealthUrl,
} from "../service-lifecycle.js";
import { ExitCode } from "../types.js";
import {
  loadServeManifestConfig,
  type ManifestConfigLoader,
  requireServeManifestConfig,
} from "./serve-manifest.js";
import { defaultWaitForShutdownSignal } from "./serve-shutdown.js";

export interface ServeDeps {
  readonly waitForShutdownSignal?: (() => Promise<string>) | undefined;
  readonly loadManifestConfig?: ManifestConfigLoader | undefined;
  readonly createRuntime?: (
    service: ServiceConfig,
    flags: ServeFlags,
    manifest: ManifestConfig,
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

  const runtime = await assembleServeRuntime(resolved.value, flags, deps);
  if (!runtime.ok) {
    process.stderr.write(`koi serve: ${runtime.error}\n`);
    return ExitCode.FAILURE;
  }

  const started = await startServeGateway(resolved.value, runtime.value.runtime, flags);
  if (!started.ok) {
    process.stderr.write(`koi serve: ${started.error}\n`);
    await disposeRuntime(runtime.value, flags);
    return ExitCode.FAILURE;
  }

  writeServeEvent(flags, {
    kind: "serve_started",
    service: resolved.value.serviceName,
    channel: started.value.channel,
    health: serviceHealthUrl(resolved.value),
    manifest: resolved.value.manifestPath,
    port: started.value.server.port(),
  });

  const shutdown = await waitForServeShutdown(deps);
  const stopped = await stopGatewayServer(started.value.server);
  await disposeRuntime(runtime.value, flags);
  if (!shutdown.ok) {
    process.stderr.write(`koi serve: ${shutdown.error}\n`);
    return ExitCode.FAILURE;
  }

  writeServeEvent(flags, {
    kind: "serve_stopped",
    service: resolved.value.serviceName,
    signal: shutdown.value,
  });
  return stopped ? ExitCode.OK : ExitCode.FAILURE;
}

type ServeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

async function assembleServeRuntime(
  service: ServiceConfig,
  flags: ServeFlags,
  deps: ServeDeps | undefined,
): Promise<ServeResult<ServeRuntimeHandle>> {
  try {
    const manifest = await loadServeManifestConfig(service.manifestPath, deps?.loadManifestConfig);
    if (!manifest.ok) return manifest;
    const runtime = await (deps?.createRuntime ?? createServeRuntime)(
      service,
      flags,
      manifest.value,
    );
    return { ok: true, value: runtime };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `runtime assembly failed - ${formatUnknownError(err)}`,
    };
  }
}

async function startServeGateway(
  service: ServiceConfig,
  runtime: Pick<KoiRuntimeHandle["runtime"], "run">,
  flags: ServeFlags,
): Promise<ServeResult<{ readonly server: GatewayServer; readonly channel: string }>> {
  const gateway = createRuntimeGateway(runtime, flags.verbose);
  const { createGatewayServer } = await import("@koi/runtime");
  const server = createGatewayServer(
    { bind: `127.0.0.1:${service.port}`, lockFilePath: service.lockFilePath },
    { gateway },
  );
  const channel = registerEnvGatewayChannel(server, service);
  if (!channel.ok) return channel;
  try {
    const started = await server.start();
    if (!started.ok) return { ok: false, error: started.error.message };
  } catch (err: unknown) {
    return { ok: false, error: `gateway start failed - ${formatUnknownError(err)}` };
  }
  return { ok: true, value: { server, channel: channel.value } };
}

async function waitForServeShutdown(deps: ServeDeps | undefined): Promise<ServeResult<string>> {
  try {
    const waitForShutdownSignal = deps?.waitForShutdownSignal ?? defaultWaitForShutdownSignal;
    return { ok: true, value: await waitForShutdownSignal() };
  } catch (err: unknown) {
    return { ok: false, error: `shutdown wait failed - ${formatUnknownError(err)}` };
  }
}

export async function createServeRuntime(
  service: ServiceConfig,
  _flags: ServeFlags,
  manifestConfig?: ManifestConfig,
): Promise<KoiRuntimeHandle> {
  const manifest = manifestConfig ?? (await requireServeManifestConfig(service.manifestPath));
  if (manifest.codeSandbox !== undefined) {
    throw new Error(
      "manifest.codeSandbox is not supported by koi serve yet; remove it or use a host that enforces a real sandbox provider",
    );
  }

  const apiConfigResult = resolveApiConfig();
  if (!apiConfigResult.ok) throw new Error(apiConfigResult.error);
  const apiConfig = apiConfigResult.value;
  const model = manifest.modelName ?? apiConfig.model;
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
    ...(manifest.instructions !== undefined ? { systemPrompt: manifest.instructions } : {}),
    ...(manifest.stacks !== undefined ? { stacks: manifest.stacks } : {}),
    ...(manifest.plugins !== undefined ? { plugins: manifest.plugins } : { plugins: [] }),
    ...(manifest.middleware !== undefined ? { manifestMiddleware: manifest.middleware } : {}),
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
