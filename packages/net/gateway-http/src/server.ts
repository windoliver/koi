/**
 * Public factory for the gateway-http server.
 *
 * Composes every Phase B/C/D primitive (channel registry, nonce + idempotency
 * stores, rate limits, ws-gate, shutdown controller, PID lock) and exposes
 * them through a Bun.serve listener.
 *
 * See `docs/superpowers/specs/2026-04-29-gateway-http-1639-design.md`.
 *
 * Scope note (D3): the WS upgrade path is wired through `ws-gate` for
 * connection accounting, but the actual WS frame protocol — wire decoding and
 * forwarding to `gateway.ingest()` — is owned by `@koi/gateway` via its own
 * transport binding mechanism. This server tracks WS connection counts so
 * shutdown can drain them, but does not transcribe WS messages itself.
 */

import type { AuditEntry, KoiError, Result } from "@koi/core";
import type { GatewayFrame, Session } from "@koi/gateway-types";
import type { Server } from "bun";
import { buildGatewayRequestEntry } from "./audit.js";
import { type ChannelRegistry, createChannelRegistry } from "./channel.js";
import { applyCors, isOriginAllowed } from "./cors.js";
import { DEFAULT_GATEWAY_HTTP_CONFIG } from "./defaults.js";
import { createIdempotencyStore } from "./idempotency.js";
import { acquireLock, type LockHandle, releaseLock } from "./lock.js";
import { createNonceStore } from "./nonce.js";
import { type PipelineDeps, runPipeline } from "./pipeline.js";
import { createRateLimitStore } from "./rate-limit.js";
import { matchRoute } from "./routing.js";
import { createShutdownController } from "./shutdown.js";
import { resolveSourceId } from "./source-id.js";
import type {
  ChannelRegistration,
  GatewayHttpConfig,
  GatewayHttpDeps,
  GatewayServer,
} from "./types.js";
import { createWsGate, type WsGate } from "./ws-gate.js";

// 0.0.0.0 binds all interfaces and is externally reachable — it must not be
// classified as loopback or the non-loopback proxy-trust guard would be bypassed.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

interface ParsedBind {
  readonly host: string;
  readonly port: number;
}

interface RuntimeState {
  readonly cfg: GatewayHttpConfig;
  readonly wsGate: WsGate;
  readonly draining: { value: boolean };
  readonly pipelineDeps: Omit<PipelineDeps, "sourceAddr">;
}

interface WsData {
  readonly token: symbol;
}

type BunServerLike = Server<WsData>;

// Mutable handle struct: factory must observe values assigned during start()
// from stop()/port(). Readonly does not apply to lifecycle slots.
interface ServerHandle {
  server: BunServerLike | null;
  lockHandle: LockHandle | null;
  resolvedPort: number;
}

export function createGatewayServer(
  config: Partial<GatewayHttpConfig>,
  deps: GatewayHttpDeps,
): GatewayServer {
  const cfg: GatewayHttpConfig = { ...DEFAULT_GATEWAY_HTTP_CONFIG, ...config };
  const clock = deps.clock ?? Date.now;
  const channelRegistry = createChannelRegistry();
  const drainingFlag = { value: false };
  // `let`-style mutable handle struct: factory must expose stop()/port() that
  // observe values assigned during start().
  const handle: ServerHandle = { server: null, lockHandle: null, resolvedPort: 0 };
  // Keep a reference to the in-flight counter so stop() can poll it.
  const inFlight = { count: 0 };

  return {
    start: () => start(cfg, deps, channelRegistry, clock, drainingFlag, inFlight, handle),
    stop: () => stop(cfg, deps, clock, drainingFlag, inFlight, handle),
    registerChannel: (reg: ChannelRegistration): Result<void, KoiError> =>
      channelRegistry.register(reg),
    port: (): number => {
      if (handle.server === null) {
        throw new Error("createGatewayServer: port() called before start()");
      }
      return handle.resolvedPort;
    },
  };
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

async function start(
  cfg: GatewayHttpConfig,
  deps: GatewayHttpDeps,
  channelRegistry: ChannelRegistry,
  clock: () => number,
  drainingFlag: { value: boolean },
  inFlight: { count: number },
  handle: ServerHandle,
): Promise<Result<void, KoiError>> {
  const cfgErr = validateConfig(cfg);
  if (cfgErr !== null) return { ok: false, error: cfgErr };

  const parsed = parseBind(cfg.bind);
  if (parsed === null) return { ok: false, error: invalidBindError(cfg.bind) };

  const lock = acquireLock(cfg.lockFilePath);
  if (!lock.ok) return { ok: false, error: lock.error };
  handle.lockHandle = lock.value;

  const state = buildRuntimeState(cfg, deps, channelRegistry, clock, drainingFlag, inFlight);
  const server = startListener(parsed, cfg, state);
  handle.server = server;
  handle.resolvedPort = server.port ?? 0;

  emitStartupAudit(deps, clock, cfg.bind);
  return { ok: true, value: undefined };
}

async function stop(
  cfg: GatewayHttpConfig,
  deps: GatewayHttpDeps,
  clock: () => number,
  drainingFlag: { value: boolean },
  inFlight: { count: number },
  handle: ServerHandle,
): Promise<void> {
  const server = handle.server;
  if (server === null) return;

  drainingFlag.value = true;
  const shutdown = createShutdownController({
    gateway: deps.gateway,
    getInFlight: () => inFlight.count,
    graceMs: cfg.shutdownGraceMs,
    clock,
    stopListener: (force) => {
      server.stop(force);
    },
  });
  await shutdown.start();

  handle.server = null;
  if (handle.lockHandle !== null) {
    releaseLock(cfg.lockFilePath, handle.lockHandle);
    handle.lockHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Runtime state composition
// ---------------------------------------------------------------------------

function buildRuntimeState(
  cfg: GatewayHttpConfig,
  deps: GatewayHttpDeps,
  channelRegistry: ChannelRegistry,
  clock: () => number,
  drainingFlag: { value: boolean },
  inFlight: { count: number },
): RuntimeState {
  const rateLimits = createRateLimitStore(clock);
  const nonces = createNonceStore({
    perTenantCapacity: cfg.nonceLruSize,
    maxTenants: cfg.maxTenantsPerChannel,
  });
  const idempotency = createIdempotencyStore(
    {
      perTenantCapacity: cfg.idempotencyLruSize,
      maxTenants: cfg.maxTenantsPerChannel,
      ttlSeconds: cfg.idempotencyTtlSeconds,
    },
    clock,
  );
  const wsGate = createWsGate({ config: cfg, rateLimits, clock });

  const emitAudit = (entry: AuditEntry): void => {
    if (deps.auditSink === undefined) return;
    void deps.auditSink.log(entry).catch(() => {
      // Audit sink failures must never break a request. Sink wiring owns
      // retry/metrics; we just don't propagate.
    });
  };

  const dispatch = makeDispatch(deps, clock);

  return {
    cfg,
    wsGate,
    draining: drainingFlag,
    pipelineDeps: {
      config: cfg,
      channels: channelRegistry,
      rateLimits,
      nonces,
      idempotency,
      clock,
      audit: emitAudit,
      dispatch,
      inFlight,
    },
  };
}

function makeDispatch(
  deps: GatewayHttpDeps,
  clock: () => number,
): (sessionId: string, agentId: string, payload: unknown) => Promise<string> {
  return async (sessionId, agentId, payload) => {
    const now = clock();
    const session: Session = {
      id: sessionId,
      agentId,
      connectedAt: now,
      lastHeartbeat: now,
      seq: 0,
      remoteSeq: 0,
      metadata: {},
    };
    const frame: GatewayFrame = {
      kind: "event",
      id: crypto.randomUUID(),
      seq: 0,
      payload,
      timestamp: now,
    };
    await deps.gateway.ingest(session, frame);
    return frame.id;
  };
}

// ---------------------------------------------------------------------------
// Bun.serve listener
// ---------------------------------------------------------------------------

function startListener(
  parsed: ParsedBind,
  cfg: GatewayHttpConfig,
  state: RuntimeState,
): BunServerLike {
  return Bun.serve<WsData>({
    hostname: parsed.host,
    port: parsed.port,
    // Bun caps idleTimeout at 255s; spec allows higher operator config but we
    // clamp to the runtime maximum so misconfiguration doesn't crash startup.
    idleTimeout: Math.min(255, cfg.wsIdleTimeoutSec),
    fetch: (req, srv) => handleFetch(req, srv, state),
    websocket: {
      open(ws): void {
        state.wsGate.onUpgradeComplete(ws.data.token, true);
      },
      close(): void {
        state.wsGate.onConnectionClose();
      },
      message(): void {
        // WS frame forwarding is owned by @koi/gateway via its own transport
        // binding. This server only tracks connection counts for shutdown.
      },
    },
  });
}

async function handleFetch(
  req: Request,
  srv: BunServerLike,
  state: RuntimeState,
): Promise<Response | undefined> {
  const socketAddr = srv.requestIP(req)?.address ?? "unknown";
  const sourceAddr = resolveSourceId(req, socketAddr, state.cfg.proxyTrust);
  const url = new URL(req.url);
  const route = matchRoute(req.method, url.pathname);

  if (route.kind === "health") {
    const drained = state.draining.value;
    return new Response(JSON.stringify({ ok: !drained, draining: drained }), {
      status: drained ? 503 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (route.kind === "preflight") {
    const r = applyCors(req, state.cfg.cors);
    if (r !== null) return r;
  }

  if (state.draining.value) {
    return new Response("draining", { status: 503 });
  }

  if (route.kind === "ws-upgrade") {
    return handleWsUpgrade(req, srv, state, sourceAddr);
  }

  if (route.kind === "webhook") {
    return runPipeline(req, { ...state.pipelineDeps, sourceAddr });
  }

  return new Response("not found", { status: 404 });
}

function handleWsUpgrade(
  req: Request,
  srv: BunServerLike,
  state: RuntimeState,
  sourceAddr: string,
): Response | undefined {
  const origin = req.headers.get("Origin");
  if (origin !== null && !isOriginAllowed(origin, state.cfg.cors)) {
    return new Response(null, { status: 403 });
  }

  const admit = state.wsGate.tryAdmit(sourceAddr);
  if (!admit.ok) return admit.response;

  const data: WsData = { token: admit.token };
  const upgraded = srv.upgrade(req, { data });
  if (!upgraded) {
    state.wsGate.onUpgradeComplete(admit.token, false);
    return new Response("upgrade failed", { status: 400 });
  }
  return undefined;
}

function emitStartupAudit(deps: GatewayHttpDeps, clock: () => number, bind: string): void {
  if (deps.auditSink === undefined) return;
  const entry = buildGatewayRequestEntry({
    timestamp: clock(),
    kind: "gateway.request",
    path: "/(start)",
    method: "INTERNAL",
    status: 200,
    latencyMs: 0,
    authResult: "skipped",
    remoteAddr: bind,
  });
  void deps.auditSink.log(entry).catch(() => {
    // Startup-audit failure is non-fatal; sink wiring owns retry semantics.
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(cfg: GatewayHttpConfig): KoiError | null {
  const parsed = parseBind(cfg.bind);
  if (parsed === null) return invalidBindError(cfg.bind);

  const isLoopback = LOOPBACK_HOSTS.has(parsed.host);
  if (!isLoopback && cfg.proxyTrust.mode === "none") {
    return {
      code: "INVALID_CONFIG",
      message:
        "Non-loopback bind requires proxyTrust.mode='trusted'; otherwise sourceAddr is the proxy IP",
      retryable: false,
      context: { bind: cfg.bind, proxyTrustMode: cfg.proxyTrust.mode },
    };
  }
  // Static type forbids `undefined`; this guard catches a caller threading
  // `undefined` through `Partial<GatewayHttpConfig>`.
  if ((cfg.sourceLimit as unknown) === undefined) {
    return {
      code: "INVALID_CONFIG",
      message: "sourceLimit must be set explicitly (RateLimitConfig or 'disabled-acknowledged')",
      retryable: false,
      context: { bind: cfg.bind },
    };
  }
  return null;
}

function invalidBindError(bind: string): KoiError {
  return {
    code: "INVALID_CONFIG",
    message: `Invalid bind address: "${bind}" (expected host:port)`,
    retryable: false,
    context: { bind },
  };
}

function parseBind(bind: string): ParsedBind | null {
  // Support "host:port" with IPv4 hostnames or "[ipv6]:port".
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(bind);
  if (m !== null) {
    const host = m[1];
    const portStr = m[2];
    if (host === undefined || portStr === undefined) return null;
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
    return { host, port };
  }
  const idx = bind.lastIndexOf(":");
  if (idx === -1) return null;
  const host = bind.slice(0, idx);
  const port = Number(bind.slice(idx + 1));
  if (host.length === 0) return null;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { host, port };
}
