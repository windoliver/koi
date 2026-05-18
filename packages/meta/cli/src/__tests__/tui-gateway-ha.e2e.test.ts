import { expect, test } from "bun:test";

const RUN_TMUX_E2E =
  process.env.KOI_RUN_TMUX_E2E === "1" || process.env.KOI_RUN_TMUX_E2E === "true";

const HOSTNAME = "127.0.0.1";
const GW_A_WS = "ws://127.0.0.1:19500";
const GW_B_WS = "ws://127.0.0.1:19510";
const NEXUS_API_KEY = "tmux-ha-test-key";
const CLIENT_ID = "failover-client";
const GW_A_CMD_ENV = "KOI_TMUX_E2E_GWA_CMD";
const GW_B_CMD_ENV = "KOI_TMUX_E2E_GWB_CMD";
const TUI_CMD_ENV = "KOI_TMUX_E2E_TUI_CMD";

type JsonRpcRequest = {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
};

type GatewaySessionRecord = {
  readonly ownerInstance: string;
  readonly session: {
    readonly id: string;
    readonly seq: number;
    readonly remoteSeq: number;
  };
};

interface TextBuffer {
  readonly read: () => string;
  readonly done: Promise<void>;
}

interface ManagedProcess {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly stdout: TextBuffer;
  readonly stderr: TextBuffer;
}

interface MockNexus {
  readonly url: string;
  readonly store: Map<string, string>;
  readonly stop: () => void;
}

interface FailoverProxy {
  readonly url: string;
  readonly logs: TextBuffer;
  readonly stop: () => void;
}

interface FailoverProxyState {
  readonly backends: readonly string[];
  queue: string[];
  upstream: WebSocket | undefined;
  opened: boolean;
  closed: boolean;
  attempt: number;
}

test.skipIf(!RUN_TMUX_E2E)(
  "real tui resumes through gateway failover",
  async () => {
    const sessionName = `koi-gw-ha-${Date.now()}`;
    const mockNexus = await startMockNexus();
    let failoverProxy: FailoverProxy | undefined;
    const gatewayEnv = {
      ...process.env,
      NEXUS_URL: mockNexus.url,
      NEXUS_API_KEY,
    };
    const gwA = spawnManagedGateway("gwA", mockNexus.url, gatewayEnv);
    let gwB: ManagedProcess | undefined;

    try {
      await waitForJsonEvent(gwA, "gateway_up_started", "gwA startup");
      gwB = spawnManagedGateway("gwB", mockNexus.url, gatewayEnv);
      await waitForJsonEvent(gwB, "gateway_up_started", "gwB startup");
      const activeGwB = gwB;
      failoverProxy = await startFailoverProxy([GW_A_WS, GW_B_WS]);

      await runTmux([
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        process.cwd(),
        tuiLauncherCommand(failoverProxy.url),
      ]);

      await waitForPaneText(
        sessionName,
        `Connected to remote gateway ${failoverProxy.url}`,
        "tui remote connect",
        async () =>
          `failover url: ${failoverProxy?.url ?? "<missing>"}\n` +
          `failover logs:\n${failoverProxy?.logs.read() ?? "<missing>"}\n\n` +
          `gwA stdout:\n${gwA.stdout.read()}\n\n` +
          `gwA stderr:\n${gwA.stderr.read()}\n\n` +
          `gwB stdout:\n${activeGwB.stdout.read()}\n\n` +
          `gwB stderr:\n${activeGwB.stderr.read()}\n\n` +
          `pane:\n${(await tryCapturePane(sessionName)) ?? "<unavailable>"}`,
      );

      await runTmux(["send-keys", "-t", sessionName, "hello before failover", "Enter"]);
      await waitFor(
        () => {
          const record = readGatewaySessionRecord(mockNexus.store, CLIENT_ID);
          return record?.ownerInstance === "gwA";
        },
        10_000,
        "initial session persisted via gwA",
        async () =>
          `gwA stdout:\n${gwA.stdout.read()}\n\ngwA stderr:\n${gwA.stderr.read()}\n\npane:\n${await capturePane(
            sessionName,
          )}`,
      );

      gwA.proc.kill("SIGKILL");
      await gwA.proc.exited;

      await runTmux(["send-keys", "-t", sessionName, "hello after failover", "Enter"]);
      await waitForPaneText(
        sessionName,
        "Gateway disconnected - reconnecting...",
        "reconnect notice",
      );
      await waitForPaneText(
        sessionName,
        "Gateway resumed existing session.",
        "resume notice",
        async () =>
          `gwB stdout:\n${activeGwB.stdout.read()}\n\ngwB stderr:\n${activeGwB.stderr.read()}\n\npane:\n${await capturePane(
            sessionName,
          )}`,
      );

      await waitFor(
        () => {
          const record = readGatewaySessionRecord(mockNexus.store, CLIENT_ID);
          return record?.ownerInstance === "gwB";
        },
        10_000,
        "session ownership moved to gwB",
        async () =>
          `gwB stdout:\n${activeGwB.stdout.read()}\n\ngwB stderr:\n${activeGwB.stderr.read()}\n\npane:\n${await capturePane(
            sessionName,
          )}`,
      );

      const finalPane = await capturePane(sessionName);
      expect(finalPane).toContain("Gateway disconnected - reconnecting...");
      expect(finalPane).toContain("Gateway resumed existing session.");

      const finalRecord = readGatewaySessionRecord(mockNexus.store, CLIENT_ID);
      expect(finalRecord?.ownerInstance).toBe("gwB");
    } finally {
      await Promise.all([
        cleanupTmuxSession(sessionName),
        stopManagedProcess(gwA, "SIGTERM"),
        ...(gwB === undefined ? [] : [stopManagedProcess(gwB, "SIGTERM")]),
      ]);
      failoverProxy?.stop();
      mockNexus.stop();
    }
  },
  60_000,
);

test("tui gateway ha e2e: $KOI_RUN_TMUX_E2E gating wired", () => {
  expect(typeof RUN_TMUX_E2E).toBe("boolean");
});

test("gateway launcher env overrides win over defaults", () => {
  const previousGwA = process.env[GW_A_CMD_ENV];
  const previousGwB = process.env[GW_B_CMD_ENV];
  const previousTui = process.env[TUI_CMD_ENV];
  process.env[GW_A_CMD_ENV] = "custom-gwa";
  process.env[GW_B_CMD_ENV] = "custom-gwb";
  process.env[TUI_CMD_ENV] = "custom-tui";
  try {
    expect(gatewayLauncherCommand("gwA", "http://nexus.local")).toBe("custom-gwa");
    expect(gatewayLauncherCommand("gwB", "http://nexus.local")).toBe("custom-gwb");
    expect(tuiLauncherCommand()).toBe("custom-tui");
  } finally {
    restoreEnv(GW_A_CMD_ENV, previousGwA);
    restoreEnv(GW_B_CMD_ENV, previousGwB);
    restoreEnv(TUI_CMD_ENV, previousTui);
  }
});

test("default launcher commands include the HA-specific arguments", () => {
  const previousGwA = process.env[GW_A_CMD_ENV];
  const previousGwB = process.env[GW_B_CMD_ENV];
  const previousTui = process.env[TUI_CMD_ENV];
  delete process.env[GW_A_CMD_ENV];
  delete process.env[GW_B_CMD_ENV];
  delete process.env[TUI_CMD_ENV];
  try {
    const gwA = gatewayLauncherCommand("gwA", "http://nexus.local");
    const gwB = gatewayLauncherCommand("gwB", "http://nexus.local");
    const tui = tuiLauncherCommand();
    expect(gwA).toContain("gateway-up");
    expect(gwA).toContain("--port 19500");
    expect(gwA).toContain("--instance-id gwA");
    expect(gwA).toContain("--nexus-url http://nexus.local");
    expect(gwA).toContain(`--nexus-api-key ${NEXUS_API_KEY}`);
    expect(gwA).toContain("--log-format json");
    expect(gwB).toContain("--port 19510");
    expect(gwB).toContain("--instance-id gwB");
    expect(tui).toContain("tui");
    expect(tui).toContain(`--gateway-url ${GW_A_WS}`);
    expect(tui).toContain(`--session ${CLIENT_ID}`);
  } finally {
    restoreEnv(GW_A_CMD_ENV, previousGwA);
    restoreEnv(GW_B_CMD_ENV, previousGwB);
    restoreEnv(TUI_CMD_ENV, previousTui);
  }
});

test("waitForJsonEvent ignores non-json lines and finds the requested event", async () => {
  const proc = createFakeManagedProcess(
    ["starting up...", '{"kind":"other"}', '{"kind":"gateway_up_started","instanceId":"gwA"}'].join(
      "\n",
    ),
    "",
  );

  const event = await waitForJsonEvent(proc, "gateway_up_started", "fake startup");
  expect(event.instanceId).toBe("gwA");
});

test("waitForJsonEvent timeout includes stdout and stderr context", async () => {
  const proc = createFakeManagedProcess('{"kind":"other"}', "boom on stderr");

  await expect(waitForJsonEvent(proc, "gateway_up_started", "missing startup", 25)).rejects.toThrow(
    "stderr:\nboom on stderr",
  );
});

test("decodeNexusContent accepts bytes payloads and rejects invalid shapes", () => {
  expect(decodeNexusContent("plain")).toBe("plain");
  expect(decodeNexusContent({ __type__: "bytes", data: "" })).toBe("");
  expect(
    decodeNexusContent({
      __type__: "bytes",
      data: Buffer.from("payload", "utf-8").toString("base64"),
    }),
  ).toBe("payload");
  expect(decodeNexusContent({ __type__: "bytes", data: 123 })).toBeUndefined();
  expect(decodeNexusContent({ nope: true })).toBeUndefined();
});

test("readGatewaySessionRecord uses the encoded session path and returns undefined when absent", () => {
  const store = new Map<string, string>();
  expect(readGatewaySessionRecord(store, "missing-client")).toBeUndefined();

  const record = {
    ownerInstance: "gwB",
    session: { id: "sess-6661696c6f7665722d636c69656e74", seq: 7, remoteSeq: 3 },
  } satisfies GatewaySessionRecord;
  store.set(nexusSessionPath(CLIENT_ID), JSON.stringify(record));

  expect(readGatewaySessionRecord(store, CLIENT_ID)).toEqual(record);
  expect(nexusSessionPath(CLIENT_ID)).toBe(
    "global/gateway/sessions/c2Vzcy02NjYxNjk2YzZmNzY2NTcyMmQ2MzZjNjk2NTZlNzQ.json",
  );
});

test("nexusSessionPath base64url-encodes unsafe client ids", () => {
  const path = nexusSessionPath("client/with+symbols=and spaces");
  expect(path).toStartWith("global/gateway/sessions/");
  expect(path).toEndWith(".json");

  const filename = path.slice("global/gateway/sessions/".length, -".json".length);
  expect(filename).not.toContain("/");
  expect(filename).not.toContain("+");
  expect(filename).not.toContain("=");
});

test("readGatewaySessionRecord ignores corrupt or partial session records", () => {
  const store = new Map<string, string>();
  store.set(nexusSessionPath(CLIENT_ID), "{not-json");
  expect(readGatewaySessionRecord(store, CLIENT_ID)).toBeUndefined();

  store.set(nexusSessionPath(CLIENT_ID), JSON.stringify({ ownerInstance: "gwA" }));
  expect(readGatewaySessionRecord(store, CLIENT_ID)).toBeUndefined();

  store.set(
    nexusSessionPath(CLIENT_ID),
    JSON.stringify({
      ownerInstance: "gwB",
      session: { id: "sess-id", seq: 1, remoteSeq: 0 },
    }),
  );
  expect(readGatewaySessionRecord(store, CLIENT_ID)?.ownerInstance).toBe("gwB");
});

test("singleQuoteForShell protects embedded quotes and shell metacharacters", () => {
  const quoted = singleQuoteForShell("alpha'beta $(touch nope); echo $HOME");
  expect(quoted).toBe(`'alpha'"'"'beta $(touch nope); echo $HOME'`);
});

test("wrapCommandForTmuxPane preserves command text and leaves an exit marker", () => {
  const wrapped = wrapCommandForTmuxPane(`printf 'hi'; exit 7`);
  expect(wrapped).toStartWith("bash -lc '");
  expect(wrapped).toContain(`printf '"'"'hi'"'"'; exit 7`);
  expect(wrapped).toContain(`printf "\\n[TUI EXIT %s]\\n" "$code"`);
  expect(wrapped).toContain("sleep 30");
});

function gatewayLauncherCommand(instanceId: "gwA" | "gwB", nexusUrl: string): string {
  const override = process.env[instanceId === "gwA" ? GW_A_CMD_ENV : GW_B_CMD_ENV];
  if (override !== undefined && override.length > 0) return override;
  const port = instanceId === "gwA" ? 19500 : 19510;
  return (
    `${process.execPath} packages/meta/cli/src/bin.ts gateway-up ` +
    `--port ${String(port)} --instance-id ${instanceId} ` +
    `--nexus-url ${nexusUrl} --nexus-api-key ${NEXUS_API_KEY} --log-format json`
  );
}

function gatewayLauncherArgs(instanceId: "gwA" | "gwB", nexusUrl: string): string[] {
  const port = instanceId === "gwA" ? 19500 : 19510;
  return [
    process.execPath,
    "packages/meta/cli/src/bin.ts",
    "gateway-up",
    "--port",
    String(port),
    "--instance-id",
    instanceId,
    "--nexus-url",
    nexusUrl,
    "--nexus-api-key",
    NEXUS_API_KEY,
    "--log-format",
    "json",
  ];
}

function tuiLauncherCommand(gatewayUrl = GW_A_WS): string {
  const override = process.env[TUI_CMD_ENV];
  if (override !== undefined && override.length > 0) return override;
  const command =
    `OPENAI_API_KEY=${singleQuoteForShell("tmux-e2e-placeholder-key")} ` +
    `KOI_GATEWAY_TOKEN=${singleQuoteForShell("tmux-e2e-gateway-token")} ` +
    `${process.execPath} packages/meta/cli/src/bin.ts tui --gateway-url ${gatewayUrl} --session ${CLIENT_ID} --no-manifest`;
  return wrapCommandForTmuxPane(command);
}

function createFakeManagedProcess(stdout: string, stderr: string): ManagedProcess {
  return {
    proc: {
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ManagedProcess["proc"],
    stdout: { read: () => stdout, done: Promise.resolve() },
    stderr: { read: () => stderr, done: Promise.resolve() },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function wrapCommandForTmuxPane(command: string): string {
  return (
    "bash -lc " +
    singleQuoteForShell(`${command}; code=$?; printf "\\n[TUI EXIT %s]\\n" "$code"; sleep 30`)
  );
}

function singleQuoteForShell(text: string): string {
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function spawnManagedGateway(
  instanceId: "gwA" | "gwB",
  nexusUrl: string,
  env: NodeJS.ProcessEnv,
): ManagedProcess {
  const override = process.env[instanceId === "gwA" ? GW_A_CMD_ENV : GW_B_CMD_ENV];
  if (override !== undefined && override.length > 0) {
    return spawnManagedShell(override, env);
  }
  return spawnManaged(gatewayLauncherArgs(instanceId, nexusUrl), env);
}

function spawnManagedShell(command: string, env: NodeJS.ProcessEnv): ManagedProcess {
  return spawnManaged(["/bin/bash", "-lc", command], env);
}

function spawnManaged(args: string[], env: NodeJS.ProcessEnv): ManagedProcess {
  const proc = Bun.spawn(args, {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    proc,
    stdout: collectText(proc.stdout),
    stderr: collectText(proc.stderr),
  };
}

function collectText(stream: ReadableStream<Uint8Array> | null): TextBuffer {
  let text = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    if (stream === null) return;
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  })();
  return {
    read: () => text,
    done,
  };
}

async function waitForJsonEvent(
  proc: ManagedProcess,
  kind: string,
  label: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return await waitFor(
    () => {
      const lines = proc.stdout
        .read()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.kind === kind) return parsed;
        } catch {
          // Ignore non-JSON output during startup.
        }
      }
      return undefined;
    },
    timeoutMs,
    label,
    async () => `stdout:\n${proc.stdout.read()}\n\nstderr:\n${proc.stderr.read()}`,
  );
}

async function runTmux(args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["tmux", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await readStream(proc.stdout);
  const stderr = await readStream(proc.stderr);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed with exit ${String(exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
}

async function capturePane(sessionName: string): Promise<string> {
  const main = await capturePaneWithArgs(["capture-pane", "-pt", sessionName, "-S", "-"]);
  const alternate = await tryCaptureAlternatePane(sessionName);
  return alternate === undefined ? main : `${main}\n${alternate}`;
}

async function tryCaptureAlternatePane(sessionName: string): Promise<string | undefined> {
  try {
    return await capturePaneWithArgs(["capture-pane", "-apt", sessionName, "-S", "-"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("no alternate screen")) return undefined;
    throw error;
  }
}

async function capturePaneWithArgs(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await readStream(proc.stdout);
  const stderr = await readStream(proc.stderr);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed with exit ${String(exitCode)}\nstderr:\n${stderr}`,
    );
  }
  return stdout;
}

async function waitForPaneText(
  sessionName: string,
  text: string,
  label: string,
  debugText?: (() => Promise<string>) | undefined,
): Promise<void> {
  await waitFor(
    async () => {
      const pane = await tryCapturePane(sessionName);
      return pane?.includes(text);
    },
    15_000,
    label,
    debugText ??
      (async () => {
        const pane = await tryCapturePane(sessionName);
        return pane ?? `<pane unavailable for session ${sessionName}>`;
      }),
  );
}

async function tryCapturePane(sessionName: string): Promise<string | undefined> {
  try {
    return await capturePane(sessionName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("can't find pane")) return undefined;
    throw error;
  }
}

async function waitFor<T>(
  predicate: () => T | Promise<T>,
  timeoutMs: number,
  label: string,
  debugText?: (() => Promise<string>) | undefined,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value as NonNullable<T>;
    }
    await Bun.sleep(100);
  }
  const detail = debugText ? await debugText() : "";
  throw new Error(`Timed out waiting for ${label}${detail.length > 0 ? `\n${detail}` : ""}`);
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function startMockNexus(): Promise<MockNexus> {
  const store = new Map<string, string>();
  const server = startMockNexusServer(store);

  return {
    url: `http://${HOSTNAME}:${server.port}`,
    store,
    stop: () => server.stop(true),
  };
}

async function startFailoverProxy(backends: readonly string[]): Promise<FailoverProxy> {
  let text = "";
  const log = (message: string): void => {
    text += `${new Date().toISOString()} ${message}\n`;
  };
  const server = bindFailoverProxy(backends, log);
  return {
    url: `ws://${HOSTNAME}:${server.port}`,
    logs: { read: () => text, done: Promise.resolve() },
    stop: () => server.stop(true),
  };
}

function bindFailoverProxy(
  backends: readonly string[],
  log: (message: string) => void,
): Bun.Server<FailoverProxyState> {
  const basePort = 27000 + Math.floor(Math.random() * 1000);
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = basePort + attempt;
    try {
      return Bun.serve<FailoverProxyState>({
        port,
        hostname: HOSTNAME,
        fetch: (request, server) => {
          const upgraded = server.upgrade(request, {
            data: {
              backends,
              queue: [],
              upstream: undefined,
              opened: false,
              closed: false,
              attempt: 0,
            },
          });
          return upgraded ? undefined : new Response("upgrade required", { status: 426 });
        },
        websocket: {
          open: (client) => {
            log("client open");
            connectFailoverProxyBackend(client, log);
          },
          message: (client, message) => {
            const text = typeof message === "string" ? message : Buffer.from(message).toString();
            const state = client.data;
            log(`client message ${String(text.length)} bytes`);
            if (state.upstream?.readyState === WebSocket.OPEN) {
              state.upstream.send(text);
              return;
            }
            state.queue.push(text);
          },
          close: (client) => {
            const state = client.data;
            log("client close");
            state.closed = true;
            state.upstream?.close();
          },
        },
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "EADDRINUSE" && !String(error).includes("EADDRINUSE")) {
        throw error;
      }
    }
  }
  throw new Error(
    `failed to bind failover proxy on ports ${String(basePort)}-${String(basePort + 199)}`,
  );
}

function connectFailoverProxyBackend(
  client: Bun.ServerWebSocket<FailoverProxyState>,
  log: (message: string) => void,
): void {
  const state = client.data;
  const backend = state.backends[state.attempt];
  if (backend === undefined) {
    log("no backend available");
    client.close();
    return;
  }
  state.attempt += 1;
  state.opened = false;
  log(`upstream connecting ${backend}`);
  const upstream = new WebSocket(backend);
  state.upstream = upstream;

  upstream.addEventListener("open", () => {
    if (state.upstream !== upstream) return;
    if (state.closed) {
      upstream.close();
      return;
    }
    log(`upstream open ${backend}`);
    state.opened = true;
    const pending = state.queue.splice(0);
    log(`upstream flush ${String(pending.length)} queued messages`);
    for (const message of pending) upstream.send(message);
  });
  upstream.addEventListener("message", (event) => {
    if (state.upstream !== upstream) return;
    log(`upstream message ${String(String(event.data).length)} bytes`);
    if (!state.closed) client.send(String(event.data));
  });
  upstream.addEventListener("close", () => {
    if (state.upstream !== upstream) return;
    log(`upstream close ${backend}`);
    if (!state.closed) client.close();
  });
  upstream.addEventListener("error", () => {
    if (state.upstream !== upstream) return;
    if (state.closed) return;
    log(`upstream error ${backend}`);
    if (!state.opened && state.attempt < state.backends.length) {
      connectFailoverProxyBackend(client, log);
      return;
    }
    client.close();
  });
}

function startMockNexusServer(store: Map<string, string>): Bun.Server<undefined> {
  const basePort = 26000 + Math.floor(Math.random() * 1000);
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = basePort + attempt;
    try {
      return Bun.serve({
        port,
        hostname: HOSTNAME,
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/health") {
            return Response.json({ status: "ok", entries: store.size });
          }
          if (!url.pathname.startsWith("/api/nfs/")) {
            return new Response("not found", { status: 404 });
          }
          const rpc = (await request.json()) as JsonRpcRequest;
          const method = decodeURIComponent(url.pathname.slice("/api/nfs/".length));
          const params = rpc.params ?? {};
          const ok = (result: unknown): Response =>
            Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
          const fail = (code: number, message: string): Response =>
            Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });

          switch (method) {
            case "version":
              return ok("mock-nexus");
            case "read_bulk": {
              const paths = Array.isArray(params.paths) ? params.paths : [];
              const result = Object.fromEntries(
                paths.map((path) => {
                  if (typeof path !== "string") return ["", null];
                  const value = store.get(path);
                  return [
                    path,
                    value === undefined
                      ? null
                      : {
                          __type__: "bytes",
                          data: Buffer.from(value, "utf-8").toString("base64"),
                        },
                  ];
                }),
              );
              return ok(result);
            }
            case "write_batch": {
              const files = Array.isArray(params.files) ? params.files : [];
              for (const file of files) {
                if (!Array.isArray(file) || typeof file[0] !== "string") {
                  return fail(-32602, "bad write_batch payload");
                }
                const text = decodeNexusContent(file[1]);
                if (text === undefined) {
                  return fail(-32602, "bad content");
                }
                store.set(file[0], text);
              }
              return ok(
                Object.fromEntries(
                  files
                    .filter((file): file is readonly [string, unknown] => Array.isArray(file))
                    .map((file) => [file[0], { success: true }]),
                ),
              );
            }
            case "delete_batch": {
              const paths = Array.isArray(params.paths) ? params.paths : [];
              return ok(
                Object.fromEntries(
                  paths.map((path) => {
                    if (typeof path !== "string") {
                      return ["", { success: false, error: "bad path" }];
                    }
                    const existed = store.delete(path);
                    return [
                      path,
                      existed ? { success: true } : { success: false, error: "File not found" },
                    ];
                  }),
                ),
              );
            }
            default:
              return fail(-32601, `unknown method: ${method}`);
          }
        },
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "EADDRINUSE" && !String(error).includes("EADDRINUSE")) {
        throw error;
      }
    }
  }
  throw new Error(
    `failed to bind mock nexus on ports ${String(basePort)}-${String(basePort + 199)}`,
  );
}

function decodeNexusContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (
    typeof content === "object" &&
    content !== null &&
    (content as { __type__?: string }).__type__ === "bytes" &&
    typeof (content as { data?: unknown }).data === "string"
  ) {
    return Buffer.from((content as { data: string }).data, "base64").toString("utf-8");
  }
  return undefined;
}

function readGatewaySessionRecord(
  store: ReadonlyMap<string, string>,
  clientId: string,
): GatewaySessionRecord | undefined {
  const text = store.get(nexusSessionPath(clientId));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<GatewaySessionRecord>;
    if (
      typeof parsed.ownerInstance !== "string" ||
      typeof parsed.session?.id !== "string" ||
      typeof parsed.session.seq !== "number" ||
      typeof parsed.session.remoteSeq !== "number"
    ) {
      return undefined;
    }
    return parsed as GatewaySessionRecord;
  } catch {
    return undefined;
  }
}

function nexusSessionPath(clientId: string): string {
  const sessionId = `sess-${Buffer.from(clientId).toString("hex")}`;
  const encoded = Buffer.from(sessionId, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `global/gateway/sessions/${encoded}.json`;
}

async function stopManagedProcess(proc: ManagedProcess, signal: NodeJS.Signals): Promise<void> {
  proc.proc.kill(signal);
  await Promise.race([proc.proc.exited, Bun.sleep(5_000)]);
  await Promise.all([proc.stdout.done, proc.stderr.done]);
}

async function cleanupTmuxSession(sessionName: string): Promise<void> {
  const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}
