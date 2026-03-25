/**
 * L3 stack activation — dynamically imports and creates stacks
 * based on PresetStacks flags.
 *
 * Each stack is dynamically imported only when enabled, keeping
 * the cold-start minimal for presets that don't use them.
 */

import type { ComponentProvider, KoiError, KoiMiddleware, Result } from "@koi/core";
import type { GovernancePendingItem } from "@koi/dashboard-types";
import type { PresetStacks } from "@koi/runtime-presets";
import type { PackageContribution, StackContribution } from "../../contribution-graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivatedStacks {
  readonly middleware: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly disposables: readonly (() => Promise<void> | void)[];
  readonly contributions: readonly StackContribution[];
  /**
   * Auto-harness outputs for forge synthesis wiring.
   * When present, `synthesizeHarness` should be passed to the forge
   * middleware stack so failure-driven demand signals trigger the full
   * synthesis loop. Requires ForgeBootstrapConfig.synthesizeHarness
   * support (tracked separately).
   */
  readonly autoHarness?: {
    readonly store: import("@koi/core").ForgeStore;
    readonly synthesizeHarness: (
      signal: import("@koi/core").ForgeDemandSignal,
    ) => Promise<import("@koi/core").BrickArtifact | null>;
    readonly maxSynthesesPerSession: number;
    readonly policyCacheHandle: unknown;
  };
  /** Governance queue commands for the admin bridge (present when governance stack is active). */
  readonly governanceCommands?: {
    readonly listGovernanceQueue: () => Result<readonly GovernancePendingItem[], KoiError>;
    readonly reviewGovernance: (
      id: string,
      decision: "approved" | "rejected",
      reason?: string,
    ) => Result<void, KoiError>;
  };
}

export interface StackActivationConfig {
  readonly stacks: PresetStacks;
  readonly forgeBootstrap:
    | {
        readonly store: unknown;
        readonly runtime: unknown;
      }
    | undefined;
  readonly verbose?: boolean;
  /**
   * When auto-harness was pre-created (e.g. for forge wiring), pass its
   * policyCacheMiddleware here so activatePresetStacks skips creating a
   * duplicate stack and injects the existing middleware instead.
   */
  readonly preCreatedAutoHarness?: {
    readonly policyCacheMiddleware: KoiMiddleware;
  };
  /** Optional context-arena config. Required when contextArena stack is enabled. */
  readonly contextArenaConfig?: import("@koi/context-arena").ContextArenaConfig | undefined;
  /** Directory for ACE SQLite databases. Required when ace stack uses "sqlite" backend. */
  readonly aceDataDir?: string;
  /** Nexus base URL for Nexus-backed ACE stores. */
  readonly nexusBaseUrl?: string;
  /** Nexus API key for Nexus-backed ACE stores. */
  readonly nexusApiKey?: string;
  /** Agent name for scoping Nexus ACE store paths (e.g. "agents/{name}/ace/..."). */
  readonly agentName?: string;
  /**
   * Sandbox config from the manifest `sandbox` field.
   * Required when sandboxStack is enabled. Passed to `createCloudSandbox()`.
   */
  readonly sandboxConfig?:
    | { readonly provider: string; readonly [key: string]: unknown }
    | undefined;
}

// ---------------------------------------------------------------------------
// Per-stack activators (each non-fatal)
// ---------------------------------------------------------------------------

function log(config: StackActivationConfig, msg: string): void {
  if (config.verbose) process.stderr.write(`  ${msg}\n`);
}

async function activateToolStack(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
): Promise<void> {
  const { createToolStack } = await import("@koi/tool-stack");
  const bundle = createToolStack();
  middleware.push(...bundle.middleware);
  log(config, `Stack: tool-stack (${String(bundle.middleware.length)} middleware)`);
}

async function activateRetryStack(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
): Promise<void> {
  const { createRetryStack } = await import("@koi/retry-stack");
  const bundle = createRetryStack({});
  middleware.push(...bundle.middleware);
  log(config, `Stack: retry-stack (${String(bundle.middleware.length)} middleware)`);
}

async function activateAutoHarness(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
): Promise<ActivatedStacks["autoHarness"]> {
  if (config.forgeBootstrap === undefined) return undefined;
  const { createAutoHarnessStack } = await import("@koi/auto-harness");
  const harnessStack = createAutoHarnessStack({
    forgeStore: config.forgeBootstrap.store as never,
    generate: async () => "",
  });
  middleware.push(harnessStack.policyCacheMiddleware);
  log(config, "Stack: auto-harness (policy cache + synthesis loop active)");
  return {
    store: config.forgeBootstrap.store as import("@koi/core").ForgeStore,
    synthesizeHarness: harnessStack.synthesizeHarness,
    maxSynthesesPerSession: harnessStack.maxSynthesesPerSession,
    policyCacheHandle: harnessStack.policyCacheHandle,
  };
}

async function activateGovernance(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
  providers: ComponentProvider[],
  disposables: (() => Promise<void> | void)[],
): Promise<ActivatedStacks["governanceCommands"]> {
  const { createGovernanceStack } = await import("@koi/governance");

  // In-memory pending queue bridges exec-approvals onAsk to the admin API.
  // When a tool call hits an "ask" rule, it lands here until the operator
  // approves/denies via the TUI governance view.
  const pendingQueue = new Map<
    string,
    {
      readonly item: GovernancePendingItem;
      readonly resolve: (decision: "approved" | "rejected") => void;
    }
  >();
  let nextId = 0;

  // Shared helper: push a tool call into the pending queue and block until operator decides.
  function enqueue(
    toolId: string,
    agentId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const id = `gov-${String(++nextId)}-${Date.now()}`;
    return new Promise((resolve) => {
      pendingQueue.set(id, {
        item: { id, agentId, requestKind: toolId, payload, timestamp: Date.now() },
        resolve: (decision) => {
          pendingQueue.delete(id);
          resolve(decision === "approved");
        },
      });
    });
  }

  // Bridge: permissions middleware "ask" tier → pending queue → admin API.
  const approvalHandler: import("@koi/middleware-permissions").ApprovalHandler = {
    requestApproval: (toolId, input, _reason) =>
      enqueue(toolId, "primary", input as Readonly<Record<string, unknown>>),
  };

  // Bridge: exec-approvals "ask" tier → pending queue → admin API.
  const onAsk: import("@koi/exec-approvals").ExecApprovalsConfig["onAsk"] = async (req) => {
    const approved = await enqueue(
      req.toolId,
      req.agentId ?? "primary",
      req.input as Readonly<Record<string, unknown>>,
    );
    return approved
      ? { kind: "allow_once" as const }
      : { kind: "deny_once" as const, reason: "Denied by operator" };
  };

  // Full governance stack with Nexus-backed audit + all standard middleware.
  // "standard" preset resolves: permissions, pii, redaction, sanitize, agent-monitor, scope.
  // We add: exec-approvals (with onAsk bridge), audit (Nexus-backed), governance-backend.
  const nexusUrl = config.nexusBaseUrl;
  const nexusApiKey = config.nexusApiKey;

  const bundle = createGovernanceStack({
    preset: "standard",
    permissions: {
      backend: (await import("@koi/middleware-permissions")).createPatternPermissionBackend({
        rules: {
          allow: ["group:fs_read", "group:web", "group:browser", "group:lsp"],
          deny: ["group:fs_delete"],
          ask: ["group:runtime"],
        },
      }),
      approvalHandler,
    },
    execApprovals: {
      rules: {
        allow: ["group:fs_read", "group:web", "group:browser"],
        deny: ["group:fs_delete"],
        ask: ["group:runtime"],
      },
      onAsk,
    },
    governanceBackend: {
      backend: (await import("@koi/governance-memory")).createGovernanceMemoryBackend({
        rules: [
          {
            id: "permit-all",
            effect: "permit" as const,
            priority: 0,
            condition: () => true,
            message: "Default permit — governance-backend allows all requests",
          },
        ],
      }),
    },
    ...(nexusUrl !== undefined && nexusApiKey !== undefined
      ? {
          auditBackend: {
            kind: "nexus" as const,
            baseUrl: nexusUrl,
            apiKey: nexusApiKey,
          },
        }
      : {}),
  });
  middleware.push(...bundle.middlewares);
  providers.push(...bundle.providers);
  for (const d of bundle.disposables) {
    disposables.push(() => d[Symbol.dispose]());
  }
  log(
    config,
    `Stack: governance (${String(bundle.middlewares.length)} middleware, preset: standard)`,
  );

  return {
    listGovernanceQueue: (): Result<readonly GovernancePendingItem[], KoiError> => ({
      ok: true,
      value: [...pendingQueue.values()].map((e) => e.item),
    }),
    reviewGovernance: (id: string, decision: "approved" | "rejected"): Result<void, KoiError> => {
      const entry = pendingQueue.get(id);
      if (entry === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Governance item ${id} not found`,
            retryable: false,
          },
        };
      }
      entry.resolve(decision);
      return { ok: true, value: undefined };
    },
  };
}

async function activateContextHub(
  config: StackActivationConfig,
  providers: ComponentProvider[],
): Promise<void> {
  const { createContextHubExecutor, createContextHubProvider } = await import(
    "@koi/tools-context-hub"
  );
  const executor = createContextHubExecutor();
  const provider = createContextHubProvider({ executor });
  providers.push(provider);
  log(config, "Stack: context-hub (chub_search + chub_get tools)");
}

async function activateContextArena(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
  providers: ComponentProvider[],
): Promise<void> {
  if (config.contextArenaConfig === undefined) {
    log(config, "Stack: context-arena skipped (no config provided)");
    return;
  }
  const { createContextArena } = await import("@koi/context-arena");
  const bundle = await createContextArena(config.contextArenaConfig);
  middleware.push(...bundle.middleware);
  providers.push(...bundle.providers);
  log(config, `Stack: context-arena (${String(bundle.middleware.length)} middleware)`);
}

async function activateAce(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
): Promise<void> {
  const backend = config.stacks.aceStoreBackend ?? "memory";
  const { createAceMiddleware } = await import("@koi/middleware-ace");

  if (backend === "nexus" && config.nexusBaseUrl !== undefined) {
    const {
      createNexusTrajectoryStore,
      createNexusPlaybookStore,
      createNexusStructuredPlaybookStore,
    } = await import("@koi/nexus-store");

    const agentPrefix = config.agentName !== undefined ? `agents/${config.agentName}/` : "";
    const nexusBase = { baseUrl: config.nexusBaseUrl, apiKey: config.nexusApiKey ?? "" };
    const trajectoryStore = createNexusTrajectoryStore({
      ...nexusBase,
      basePath: `${agentPrefix}ace/trajectories`,
    });
    const playbookStore = createNexusPlaybookStore({
      ...nexusBase,
      basePath: `${agentPrefix}ace/playbooks`,
    });
    const structuredPlaybookStore = createNexusStructuredPlaybookStore({
      ...nexusBase,
      basePath: `${agentPrefix}ace/structured-playbooks`,
    });

    const mw = createAceMiddleware({ trajectoryStore, playbookStore, structuredPlaybookStore });
    middleware.push(mw);
    log(config, `Stack: ace (backend=nexus, url=${config.nexusBaseUrl})`);
    return;
  }

  // Nexus requested but no URL available — fall back to SQLite
  if (backend === "nexus") {
    log(config, "Stack: ace — Nexus URL not available, falling back to sqlite");
  }

  if ((backend === "sqlite" || backend === "nexus") && config.aceDataDir !== undefined) {
    const { resolve } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    const dbDir = config.aceDataDir;
    mkdirSync(dbDir, { recursive: true });

    const {
      createSqliteTrajectoryStore,
      createSqlitePlaybookStore,
      createSqliteStructuredPlaybookStore,
    } = await import("@koi/middleware-ace");

    const dbPath = resolve(dbDir, "ace.db");
    const trajectoryStore = createSqliteTrajectoryStore({ dbPath });
    const playbookStore = createSqlitePlaybookStore({ dbPath });
    const structuredPlaybookStore = createSqliteStructuredPlaybookStore({ dbPath });

    const mw = createAceMiddleware({ trajectoryStore, playbookStore, structuredPlaybookStore });
    middleware.push(mw);
    log(config, `Stack: ace (backend=sqlite, db=${dbPath})`);
  } else {
    const {
      createInMemoryTrajectoryStore,
      createInMemoryPlaybookStore,
      createInMemoryStructuredPlaybookStore,
    } = await import("@koi/middleware-ace");

    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();

    const mw = createAceMiddleware({ trajectoryStore, playbookStore, structuredPlaybookStore });
    middleware.push(mw);
    log(config, `Stack: ace (backend=memory)`);
  }
}

async function activateSandboxStack(
  config: StackActivationConfig,
  providers: ComponentProvider[],
  disposables: (() => Promise<void> | void)[],
): Promise<void> {
  if (config.sandboxConfig === undefined) {
    log(config, "Stack: sandbox-stack skipped (no sandbox config in manifest)");
    return;
  }

  const { createCloudSandbox, createSandboxStack, createExecuteCodeProvider } = await import(
    "@koi/sandbox-stack"
  );

  const adapterResult = await createCloudSandbox(
    config.sandboxConfig as import("@koi/sandbox-stack").CloudSandboxConfig,
  );
  if (!adapterResult.ok) {
    const msg = adapterResult.error.message;
    log(config, `Stack: sandbox-stack failed — ${msg}`);
    // Fail-fast: surface actionable error, do not silently degrade
    process.stderr.write(
      `  warn: sandbox-stack: ${msg}. Check your manifest sandbox config or install the provider package.\n`,
    );
    return;
  }

  const stack = createSandboxStack({ adapter: adapterResult.value });
  const provider = createExecuteCodeProvider(stack);
  providers.push(provider);
  disposables.push(() => stack.dispose());
  log(
    config,
    `Stack: sandbox-stack (provider=${config.sandboxConfig.provider}, execute_code tool)`,
  );
}

async function activateCodeExecutor(
  config: StackActivationConfig,
  providers: ComponentProvider[],
): Promise<void> {
  const { createCodeExecutorProvider } = await import("@koi/sandbox-stack");
  const provider = createCodeExecutorProvider();
  providers.push(provider);
  // Note: code-executor provider has priority BUNDLED+10, so assembly
  // sorts it after other tool providers (it queries existing tools).
  log(config, "Stack: code-executor (execute_script WASM tool)");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Activates L3 middleware stacks based on preset flags.
 */
export async function activatePresetStacks(
  config: StackActivationConfig,
): Promise<ActivatedStacks> {
  const middleware: KoiMiddleware[] = [];
  const providers: ComponentProvider[] = [];
  const disposables: (() => Promise<void> | void)[] = [];
  const contributions: StackContribution[] = [];
  // let justified: captured from auto-harness activation for forge wiring
  let autoHarnessResult: ActivatedStacks["autoHarness"];

  const tryActivate = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`  warn: ${name} failed: ${message}\n`);
      // Record as failed contribution so the debug view shows what failed and why
      contributions.push({
        id: name,
        label: name,
        enabled: false,
        source: "runtime",
        status: "failed",
        reason: message,
        packages: [{ id: name, kind: "subsystem", source: "static", notes: [message] }],
      });
    }
  };

  if (config.stacks.toolStack === true) {
    const before = middleware.length;
    await tryActivate("tool-stack", () => activateToolStack(config, middleware));
    if (middleware.length > before) {
      contributions.push({
        id: "tool-stack",
        label: "Tool Stack",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/tool-stack",
            kind: "middleware",
            source: "static",
            middlewareNames: middleware.slice(before).map((m) => m.name),
          },
        ],
      });
    }
  }

  if (config.stacks.retryStack === true) {
    const before = middleware.length;
    await tryActivate("retry-stack", () => activateRetryStack(config, middleware));
    if (middleware.length > before) {
      contributions.push({
        id: "retry-stack",
        label: "Retry Stack",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/retry-stack",
            kind: "middleware",
            source: "static",
            middlewareNames: middleware.slice(before).map((m) => m.name),
          },
        ],
      });
    }
  }

  if (config.stacks.autoHarness === true) {
    if (config.preCreatedAutoHarness !== undefined) {
      // Use the pre-created instance (already wired into forge bootstrap)
      middleware.push(config.preCreatedAutoHarness.policyCacheMiddleware);
      log(config, "Stack: auto-harness (pre-created, policy cache active)");
      contributions.push({
        id: "auto-harness",
        label: "Auto Harness",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/auto-harness",
            kind: "middleware",
            source: "static",
            middlewareNames: [config.preCreatedAutoHarness.policyCacheMiddleware.name],
            notes: ["pre-created"],
          },
        ],
      });
    } else {
      try {
        const before = middleware.length;
        autoHarnessResult = await activateAutoHarness(config, middleware);
        if (middleware.length > before) {
          contributions.push({
            id: "auto-harness",
            label: "Auto Harness",
            enabled: true,
            source: "runtime",
            status: "active",
            packages: [
              {
                id: "@koi/auto-harness",
                kind: "middleware",
                source: "static",
                middlewareNames: middleware.slice(before).map((m) => m.name),
              },
            ],
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (config.verbose) process.stderr.write(`  warn: auto-harness failed: ${message}\n`);
        contributions.push({
          id: "auto-harness",
          label: "Auto Harness",
          enabled: false,
          source: "runtime",
          status: "failed",
          reason: message,
          packages: [
            { id: "@koi/auto-harness", kind: "subsystem", source: "static", notes: [message] },
          ],
        });
      }
    }
  }

  let governanceCommands: ActivatedStacks["governanceCommands"];
  if (config.stacks.governance === true) {
    const mwBefore = middleware.length;
    const provBefore = providers.length;
    await tryActivate("governance", async () => {
      governanceCommands = await activateGovernance(config, middleware, providers, disposables);
    });
    if (middleware.length > mwBefore || providers.length > provBefore) {
      const pkgs: PackageContribution[] = [];
      if (middleware.length > mwBefore) {
        pkgs.push({
          id: "@koi/governance",
          kind: "middleware",
          source: "static",
          middlewareNames: middleware.slice(mwBefore).map((m) => m.name),
        });
      }
      if (providers.length > provBefore) {
        pkgs.push({
          id: "@koi/governance",
          kind: "provider",
          source: "static",
          providerNames: providers.slice(provBefore).map((p) => p.name),
        });
      }
      contributions.push({
        id: "governance",
        label: "Governance",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: pkgs,
      });
    }
  }

  if (config.stacks.contextHub === true) {
    const before = providers.length;
    await tryActivate("context-hub", () => activateContextHub(config, providers));
    if (providers.length > before) {
      contributions.push({
        id: "context-hub",
        label: "Context Hub",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/tools-context-hub",
            kind: "provider",
            source: "static",
            providerNames: providers.slice(before).map((p) => p.name),
          },
        ],
      });
    }
  }

  if (config.stacks.contextArena === true) {
    const mwBefore = middleware.length;
    const provBefore = providers.length;
    await tryActivate("context-arena", () => activateContextArena(config, middleware, providers));
    if (middleware.length > mwBefore || providers.length > provBefore) {
      const pkgs: PackageContribution[] = [];
      if (middleware.length > mwBefore) {
        pkgs.push({
          id: "@koi/context-arena",
          kind: "middleware",
          source: "static",
          middlewareNames: middleware.slice(mwBefore).map((m) => m.name),
        });
      }
      if (providers.length > provBefore) {
        pkgs.push({
          id: "@koi/context-arena",
          kind: "provider",
          source: "static",
          providerNames: providers.slice(provBefore).map((p) => p.name),
        });
      }
      contributions.push({
        id: "context-arena",
        label: "Context Arena",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: pkgs,
      });
    }
  }

  if (config.stacks.ace === true) {
    const before = middleware.length;
    await tryActivate("ace", () => activateAce(config, middleware));
    if (middleware.length > before) {
      contributions.push({
        id: "ace",
        label: "ACE",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/middleware-ace",
            kind: "middleware",
            source: "static",
            middlewareNames: middleware.slice(before).map((m) => m.name),
          },
        ],
      });
    }
  }

  if (config.stacks.goalStack === true) {
    const mwBefore = middleware.length;
    const provBefore = providers.length;
    await tryActivate("goal-stack", async () => {
      const { createGoalStack } = await import("@koi/goal-stack");
      const bundle = createGoalStack({ preset: "minimal" });
      middleware.push(...bundle.middlewares);
      providers.push(...bundle.providers);
      log(config, `Stack: goal-stack (${String(bundle.middlewares.length)} middleware)`);
    });
    if (middleware.length > mwBefore || providers.length > provBefore) {
      const pkgs: PackageContribution[] = [];
      if (middleware.length > mwBefore) {
        pkgs.push({
          id: "@koi/goal-stack",
          kind: "middleware",
          source: "static",
          middlewareNames: middleware.slice(mwBefore).map((m) => m.name),
        });
      }
      if (providers.length > provBefore) {
        pkgs.push({
          id: "@koi/goal-stack",
          kind: "provider",
          source: "static",
          providerNames: providers.slice(provBefore).map((p) => p.name),
        });
      }
      contributions.push({
        id: "goal-stack",
        label: "Goal Stack",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: pkgs,
      });
    }
  }

  if (config.stacks.qualityGate === true) {
    const before = middleware.length;
    await tryActivate("quality-gate", async () => {
      const { createQualityGate } = await import("@koi/quality-gate");
      // Use "light" preset — no per-session model call budget.
      // The "standard" preset (default) limits to 6 calls which breaks
      // multi-turn demos and forge sessions.
      const bundle = createQualityGate({ preset: "light" });
      middleware.push(...bundle.middleware);
      log(config, `Stack: quality-gate (${String(bundle.middleware.length)} middleware)`);
    });
    if (middleware.length > before) {
      contributions.push({
        id: "quality-gate",
        label: "Quality Gate",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/quality-gate",
            kind: "middleware",
            source: "static",
            middlewareNames: middleware.slice(before).map((m) => m.name),
          },
        ],
      });
    }
  }

  if (config.stacks.sandboxStack === true) {
    const before = providers.length;
    await tryActivate("sandbox-stack", () => activateSandboxStack(config, providers, disposables));
    if (providers.length > before) {
      contributions.push({
        id: "sandbox-stack",
        label: "Sandbox Stack",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/sandbox-stack",
            kind: "provider",
            source: "static",
            providerNames: providers.slice(before).map((p) => p.name),
          },
        ],
      });
    }
  }

  // Code executor (WASM execute_script) must be activated AFTER sandbox-stack
  // and other tool providers. The provider has priority BUNDLED+10, so assembly
  // sorts it after standard-priority providers regardless of push order.
  if (config.stacks.codeExecutor === true) {
    const before = providers.length;
    await tryActivate("code-executor", () => activateCodeExecutor(config, providers));
    if (providers.length > before) {
      contributions.push({
        id: "code-executor",
        label: "Code Executor",
        enabled: true,
        source: "runtime",
        status: "active",
        packages: [
          {
            id: "@koi/sandbox-stack",
            kind: "provider",
            source: "static",
            providerNames: providers.slice(before).map((p) => p.name),
            notes: ["WASM execute_script"],
          },
        ],
      });
    }
  }

  return {
    middleware,
    providers,
    disposables,
    contributions,
    ...(autoHarnessResult !== undefined ? { autoHarness: autoHarnessResult } : {}),
    ...(governanceCommands !== undefined ? { governanceCommands } : {}),
  };
}
