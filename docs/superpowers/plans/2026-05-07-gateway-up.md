# `koi gateway-up` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `koi gateway-up` CLI command that reuses the restored gateway-stack local launcher, preserves loopback-only behavior, and keeps the legacy script as a thin wrapper.

**Architecture:** Split the work into two layers: a reusable launcher helper inside `@koi/gateway-stack`, and a thin CLI command inside `packages/meta/cli`. The CLI owns parsing/help/registry wiring and delegates all runtime assembly + lifecycle behavior to the shared gateway-stack launcher so the script and CLI cannot drift.

**Tech Stack:** Bun, TypeScript, `node:util.parseArgs` via existing CLI helpers, `@koi/gateway-stack`, `@koi/gateway`, `@koi/nexus-client`, `bun:test`.

---

## File Structure

**Create:**
- `packages/net/gateway-stack/src/local-launcher.ts`
- `packages/net/gateway-stack/src/local-launcher.test.ts`
- `packages/meta/cli/src/args/gateway-up.ts`
- `packages/meta/cli/src/commands/gateway-up.ts`

**Modify:**
- `packages/net/gateway-stack/src/index.ts`
- `packages/net/gateway-stack/scripts/gateway-up.ts`
- `packages/meta/cli/src/args/index.ts`
- `packages/meta/cli/src/args.test.ts`
- `packages/meta/cli/src/help.ts`
- `packages/meta/cli/src/registry.ts`
- `packages/meta/cli/src/index.ts`

**Verify / Test:**
- `packages/net/gateway-stack/src/local-launcher.test.ts`
- `packages/meta/cli/src/args.test.ts`
- existing CLI startup/help tests if they need snapshots or command-name updates

## Task 1: Add the CLI flag type and parser

**Files:**
- Create: `packages/meta/cli/src/args/gateway-up.ts`
- Modify: `packages/meta/cli/src/args/index.ts`
- Test: `packages/meta/cli/src/args.test.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args/index.js";

describe("parseArgs - gateway-up", () => {
  test("parses default gateway-up flags", () => {
    const flags = parseArgs(["gateway-up"]);
    expect(flags).toMatchObject({
      command: "gateway-up",
      port: undefined,
      nexusUrl: undefined,
      nexusApiKey: undefined,
      instanceId: undefined,
      logFormat: "text",
      help: false,
      version: false,
    });
  });

  test("parses explicit gateway-up options", () => {
    const flags = parseArgs([
      "gateway-up",
      "--port",
      "19500",
      "--nexus-url",
      "http://127.0.0.1:4515",
      "--nexus-api-key",
      "secret",
      "--instance-id",
      "gw-a",
      "--log-format",
      "json",
    ]);
    expect(flags).toMatchObject({
      command: "gateway-up",
      port: 19500,
      nexusUrl: "http://127.0.0.1:4515",
      nexusApiKey: "secret",
      instanceId: "gw-a",
      logFormat: "json",
    });
  });

  test("rejects an out-of-range port", () => {
    expect(() => parseArgs(["gateway-up", "--port", "70000"])).toThrow(/port/i);
  });
});
```

- [ ] **Step 2: Run the parser tests to verify they fail**

Run: `rtk bun test packages/meta/cli/src/args.test.ts`

Expected: FAIL because `gateway-up` is not a known command and `parseArgs()` does not yet know how to parse the new flags.

- [ ] **Step 3: Add the `GatewayUpFlags` parser**

```ts
// packages/meta/cli/src/args/gateway-up.ts
import type { BaseFlags } from "./shared.js";
import { parseIntFlag, resolveLogFormat, typedParseArgs } from "./shared.js";

export interface GatewayUpFlags extends BaseFlags {
  readonly command: "gateway-up";
  readonly port: number | undefined;
  readonly nexusUrl: string | undefined;
  readonly nexusApiKey: string | undefined;
  readonly instanceId: string | undefined;
  readonly logFormat: "text" | "json";
}

export function parseGatewayUpFlags(rest: readonly string[]): GatewayUpFlags {
  type V = {
    readonly port: string | undefined;
    readonly "nexus-url": string | undefined;
    readonly "nexus-api-key": string | undefined;
    readonly "instance-id": string | undefined;
    readonly "log-format": string | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        port: { type: "string" },
        "nexus-url": { type: "string" },
        "nexus-api-key": { type: "string" },
        "instance-id": { type: "string" },
        "log-format": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: false,
    },
    "gateway-up",
  );

  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const skipValidators = helpRequested || versionRequested;

  return {
    command: "gateway-up",
    help: helpRequested,
    version: versionRequested,
    port:
      values.port === undefined
        ? undefined
        : skipValidators
          ? undefined
          : parseIntFlag("port", values.port, 1, 65535),
    nexusUrl: values["nexus-url"],
    nexusApiKey: values["nexus-api-key"],
    instanceId: values["instance-id"],
    logFormat: skipValidators ? "text" : resolveLogFormat(values["log-format"]),
  };
}

export function isGatewayUpFlags(flags: BaseFlags): flags is GatewayUpFlags {
  return flags.command === "gateway-up";
}
```

- [ ] **Step 4: Wire the parser into the command registry types**

```ts
// packages/meta/cli/src/args/index.ts
export type KnownCommand =
  | "init"
  | "start"
  | "serve"
  | "gateway-up"
  | "tui"
  | "sessions"
  | "logs"
  | "status"
  | "doctor"
  | "dream"
  | "stop"
  | "deploy"
  | "mcp"
  | "plugin"
  | "bg";

const KNOWN_COMMANDS: ReadonlyArray<KnownCommand> = [
  "init",
  "start",
  "serve",
  "gateway-up",
  "tui",
  "sessions",
  "logs",
  "status",
  "doctor",
  "dream",
  "stop",
  "deploy",
  "mcp",
  "plugin",
  "bg",
];

const COMMAND_PARSERS: Readonly<Record<KnownCommand, CommandParser>> = {
  init: parseInitFlags,
  start: parseStartFlags,
  serve: parseServeFlags,
  "gateway-up": parseGatewayUpFlags,
  tui: parseTuiFlags,
  sessions: parseSessionsFlags,
  logs: parseLogsFlags,
  status: parseStatusFlags,
  doctor: parseDoctorFlags,
  dream: parseDreamFlags,
  stop: parseStopFlags,
  deploy: parseDeployFlags,
  mcp: parseMcpFlags,
  plugin: parsePluginFlags,
  bg: parseBgFlags,
};
```

- [ ] **Step 5: Re-run the parser tests**

Run: `rtk bun test packages/meta/cli/src/args.test.ts`

Expected: PASS for the new `gateway-up` parsing cases.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/meta/cli/src/args/gateway-up.ts packages/meta/cli/src/args/index.ts packages/meta/cli/src/args.test.ts
rtk git commit -m "feat(cli): add gateway-up args parser"
```

## Task 2: Extract a reusable gateway-stack local launcher

**Files:**
- Create: `packages/net/gateway-stack/src/local-launcher.ts`
- Create: `packages/net/gateway-stack/src/local-launcher.test.ts`
- Modify: `packages/net/gateway-stack/src/index.ts`
- Test: `packages/net/gateway-stack/src/local-launcher.test.ts`

- [ ] **Step 1: Write failing launcher tests**

```ts
import { describe, expect, test } from "bun:test";
import { createLocalGatewayLauncher } from "./local-launcher.js";

describe("createLocalGatewayLauncher", () => {
  test("rejects nexusUrl without nexusApiKey", async () => {
    const launcher = createLocalGatewayLauncher();
    await expect(
      launcher.start({
        port: 19500,
        hostname: "127.0.0.1",
        nexusUrl: "http://127.0.0.1:4515",
      }),
    ).rejects.toThrow(/NEXUS_API_KEY/i);
  });

  test("returns ws + health addresses for loopback startup", async () => {
    const launcher = createLocalGatewayLauncher();
    const started = await launcher.start({ port: 19500, hostname: "127.0.0.1" });
    expect(started.started.kind).toBe("gateway_up_started");
    expect(started.started.ws).toContain("ws://127.0.0.1:");
    expect(started.started.health).toContain("http://127.0.0.1:");
    await started.stop("test");
  });
});
```

- [ ] **Step 2: Run the launcher tests to verify they fail**

Run: `rtk bun test packages/net/gateway-stack/src/local-launcher.test.ts`

Expected: FAIL because `local-launcher.ts` does not exist yet.

- [ ] **Step 3: Implement the shared launcher helper**

```ts
// packages/net/gateway-stack/src/local-launcher.ts
import { createBunTransport, type GatewayAuthenticator, type Transport } from "@koi/gateway";
import { createHttpTransport, type NexusTransport } from "@koi/nexus-client";
import { createGatewayStack, type GatewayStack } from "./create-gateway-stack.js";

export interface LocalGatewayLauncherConfig {
  readonly port: number;
  readonly hostname?: string;
  readonly nexusUrl?: string;
  readonly nexusApiKey?: string;
  readonly instanceId?: string;
}

export interface GatewayUpStartedEvent {
  readonly kind: "gateway_up_started";
  readonly instanceId: string;
  readonly ws: string;
  readonly health: string;
  readonly nexus: string | null;
}

export function createLocalGatewayLauncher() {
  return {
    async start(config: LocalGatewayLauncherConfig) {
      if (config.nexusUrl !== undefined && config.nexusApiKey === undefined) {
        throw new Error("NEXUS_URL set but NEXUS_API_KEY missing");
      }

      const hostname = config.hostname ?? "127.0.0.1";
      const instanceId = config.instanceId ?? `gw-${process.pid}`;
      const auth: GatewayAuthenticator = {
        authenticate: async (frame) => {
          const clientId = frame.client?.id ?? "default-agent";
          const sessionId = `sess-${Buffer.from(clientId).toString("hex")}`;
          return { ok: true, sessionId, agentId: clientId, metadata: { unsafeDevAuth: true } };
        },
      };

      const nexusTransport: NexusTransport | undefined =
        config.nexusUrl !== undefined && config.nexusApiKey !== undefined
          ? createHttpTransport({ url: config.nexusUrl, apiKey: config.nexusApiKey })
          : undefined;

      const stack: GatewayStack = createGatewayStack(
        { ...(nexusTransport ? { nexus: { instanceId } } : {}) },
        {
          transport: createBunTransport({ hostname }) as Transport,
          auth,
          ...(nexusTransport ? { nexusTransport } : {}),
        },
      );

      await stack.start(config.port);
      const healthServer = Bun.serve({
        port: config.port + 1,
        hostname,
        fetch: (req) => stack.healthHandler(req),
      });

      const started: GatewayUpStartedEvent = {
        kind: "gateway_up_started",
        instanceId,
        ws: `ws://${hostname}:${config.port}`,
        health: `http://${hostname}:${healthServer.port}/health`,
        nexus: nexusTransport ? config.nexusUrl! : null,
      };

      return {
        started,
        async stop(signal: string) {
          healthServer.stop();
          await stack.stop();
          return { kind: "gateway_up_stopped" as const, signal };
        },
      };
    },
  };
}
```

- [ ] **Step 4: Export the helper from the package entrypoint**

```ts
// packages/net/gateway-stack/src/index.ts
export {
  createLocalGatewayLauncher,
  type GatewayUpStartedEvent,
  type LocalGatewayLauncherConfig,
} from "./local-launcher.js";
```

- [ ] **Step 5: Re-run the launcher tests**

Run: `rtk bun test packages/net/gateway-stack/src/local-launcher.test.ts`

Expected: PASS for config validation and loopback startup/stop.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/net/gateway-stack/src/local-launcher.ts packages/net/gateway-stack/src/local-launcher.test.ts packages/net/gateway-stack/src/index.ts
rtk git commit -m "feat(gateway-stack): extract local gateway launcher"
```

## Task 3: Add the CLI command and convert the script into a thin wrapper

**Files:**
- Create: `packages/meta/cli/src/commands/gateway-up.ts`
- Modify: `packages/meta/cli/src/registry.ts`
- Modify: `packages/meta/cli/src/help.ts`
- Modify: `packages/meta/cli/src/index.ts`
- Modify: `packages/net/gateway-stack/scripts/gateway-up.ts`
- Test: `packages/meta/cli/src/args.test.ts`

- [ ] **Step 1: Write the failing command-wiring tests**

```ts
import { describe, expect, test } from "bun:test";
import { COMMAND_HELP } from "./help.js";
import { COMMAND_LOADERS } from "./registry.js";

describe("gateway-up command wiring", () => {
  test("help text includes gateway-up", () => {
    expect(COMMAND_HELP["gateway-up"]).toContain("koi gateway-up");
    expect(COMMAND_HELP["gateway-up"]).toContain("--nexus-url");
  });

  test("registry exposes a gateway-up loader", () => {
    expect(typeof COMMAND_LOADERS["gateway-up"]).toBe("function");
  });
});
```

- [ ] **Step 2: Run the command-wiring tests to verify they fail**

Run: `rtk bun test packages/meta/cli/src/args.test.ts packages/meta/cli/src/bin.test.ts`

Expected: FAIL because help text and registry do not yet include `gateway-up`.

- [ ] **Step 3: Implement the CLI command module**

```ts
// packages/meta/cli/src/commands/gateway-up.ts
import { createLocalGatewayLauncher } from "@koi/gateway-stack";
import type { CliFlags } from "../args.js";
import { isGatewayUpFlags } from "../args/gateway-up.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isGatewayUpFlags(flags)) return ExitCode.FAILURE;
  try {
    const launcher = createLocalGatewayLauncher();
    const started = await launcher.start({
      port: flags.port ?? 19500,
      hostname: "127.0.0.1",
      nexusUrl: flags.nexusUrl,
      nexusApiKey: flags.nexusApiKey,
      instanceId: flags.instanceId,
    });

    process.stdout.write(`${JSON.stringify(started.started)}\n`);

    await new Promise<void>((resolve) => {
      const shutdown = async (signal: string) => {
        process.stdout.write(`${JSON.stringify({ kind: "gateway_up_stopping", signal })}\n`);
        await started.stop(signal);
        resolve();
      };
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
    });

    process.stdout.write(`${JSON.stringify({ kind: "gateway_up_stopped" })}\n`);
    return ExitCode.OK;
  } catch (err) {
    process.stderr.write(`koi gateway-up: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.FAILURE;
  }
}
```

- [ ] **Step 4: Wire help text, registry, and public exports**

```ts
// packages/meta/cli/src/help.ts
const gatewayUpHelp = `koi gateway-up — Start the loopback gateway stack

Usage:
  koi gateway-up [options]

Options:
      --port <n>               WebSocket port (default 19500)
      --nexus-url <url>        Optional Nexus base URL
      --nexus-api-key <key>    Nexus API key (required with --nexus-url)
      --instance-id <id>       Gateway instance id
      --log-format <text|json> Output format
  -h, --help                   Show this help
`;

// add "gateway-up": gatewayUpHelp to COMMAND_HELP

// packages/meta/cli/src/registry.ts
"gateway-up": () => import("./commands/gateway-up.js"),
```

- [ ] **Step 5: Replace the script body with a wrapper over the shared launcher**

```ts
#!/usr/bin/env bun
import { createLocalGatewayLauncher } from "../src/index.js";

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
```

- [ ] **Step 6: Re-run the CLI wiring tests**

Run: `rtk bun test packages/meta/cli/src/args.test.ts packages/meta/cli/src/bin.test.ts`

Expected: PASS with `gateway-up` recognized in the command registry and help text.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/meta/cli/src/commands/gateway-up.ts packages/meta/cli/src/registry.ts packages/meta/cli/src/help.ts packages/meta/cli/src/index.ts packages/net/gateway-stack/scripts/gateway-up.ts
rtk git commit -m "feat(cli): add gateway-up command"
```

## Task 4: Full verification and cleanup

**Files:**
- Modify: any touched files from prior tasks only if verification exposes a defect
- Test: `packages/meta/cli/src/args.test.ts`
- Test: `packages/net/gateway-stack/src/local-launcher.test.ts`

- [ ] **Step 1: Run focused test suites**

Run: `rtk bun test packages/meta/cli/src/args.test.ts packages/net/gateway-stack/src/local-launcher.test.ts`

Expected: PASS with the parser, CLI wiring, and launcher lifecycle all green.

- [ ] **Step 2: Run a command smoke test**

Run: `rtk bun run packages/meta/cli/src/bin.ts gateway-up --help`

Expected: stdout contains:

```text
koi gateway-up — Start the loopback gateway stack
--port <n>
--nexus-url <url>
--nexus-api-key <key>
```

- [ ] **Step 3: Run a startup smoke test**

Run: `rtk bun run packages/meta/cli/src/bin.ts gateway-up --port 19600`

Expected first stdout line:

```json
{"kind":"gateway_up_started","instanceId":"gw-...","ws":"ws://127.0.0.1:19600","health":"http://127.0.0.1:19601/health","nexus":null}
```

Then interrupt with `Ctrl-C` and expect:

```json
{"kind":"gateway_up_stopping","signal":"SIGINT"}
{"kind":"gateway_up_stopped"}
```

- [ ] **Step 4: Re-run formatting or targeted checks only if verification found drift**

Run: `rtk bun test packages/meta/cli/src/args.test.ts packages/net/gateway-stack/src/local-launcher.test.ts`

Expected: PASS again after any cleanup edit.

- [ ] **Step 5: Final commit**

```bash
rtk git add packages/meta/cli/src/args/gateway-up.ts packages/meta/cli/src/commands/gateway-up.ts packages/meta/cli/src/args/index.ts packages/meta/cli/src/args.test.ts packages/meta/cli/src/help.ts packages/meta/cli/src/registry.ts packages/meta/cli/src/index.ts packages/net/gateway-stack/src/local-launcher.ts packages/net/gateway-stack/src/local-launcher.test.ts packages/net/gateway-stack/src/index.ts packages/net/gateway-stack/scripts/gateway-up.ts
rtk git commit -m "feat: promote gateway-up to a first-class CLI command"
```

## Self-Review

- Spec coverage:
  - first-class CLI command: Tasks 1 and 3
  - shared launcher extraction: Task 2
  - loopback-only + existing behavior preservation: Tasks 2 and 3
  - legacy script thin wrapper: Task 3
  - focused verification: Task 4
- Placeholder scan:
  - no `TBD`, `TODO`, or deferred “write tests later” steps remain
  - each task includes concrete files, code snippets, and commands
- Type consistency:
  - command name is consistently `gateway-up`
  - config names are consistently `nexusUrl`, `nexusApiKey`, `instanceId`, `port`
  - shared launcher is consistently `createLocalGatewayLauncher`
