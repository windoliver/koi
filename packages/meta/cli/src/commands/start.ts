/**
 * `koi start` — run agent in interactive REPL or single-prompt mode.
 *
 * Wires @koi/harness → @koi/engine (createKoi) → @koi/model-openai-compat
 * with @koi/channel-cli for I/O. Sessions are persisted to JSONL transcripts
 * at ~/.koi/sessions/<sessionId>.jsonl and can be resumed with --resume.
 *
 * Tools wired by default (all from ~/.koi/ or cwd):
 *   Glob, Grep           — @koi/tools-builtin (builtin-search provider)
 *   web_fetch            — @koi/tools-web (requires network)
 *   Bash                 — @koi/tools-bash (workspace-rooted)
 *   fs_read/write/edit   — @koi/tools-builtin + @koi/runtime (filesystem provider)
 *   MCP tools            — .mcp.json in cwd (optional, skipped if absent)
 *   Hooks                — ~/.koi/hooks.json (optional, skipped if absent)
 *   Permissions          — auto-allow (allow:['*']); gates can be tightened later
 *
 * API key resolution: OPENROUTER_API_KEY or OPENAI_API_KEY (see env.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import { enforceBudget } from "@koi/context-manager";

import type {
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  InboundMessage,
  KoiMiddleware,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, sessionId, toolToken } from "@koi/core";
import { createKoi, createSystemPromptMiddleware } from "@koi/engine";
import { createCliHarness } from "@koi/harness";
import { createHookMiddleware, createRegisteredHooks, loadRegisteredHooks } from "@koi/hooks";
import { createMcpComponentProvider, createMcpResolver, loadMcpJsonFile } from "@koi/mcp";
import {
  createPatternPermissionBackend,
  createPermissionsMiddleware,
} from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { runTurn } from "@koi/query-engine";
import {
  createJsonlTranscript,
  createSessionTranscriptMiddleware,
  resumeForSession,
} from "@koi/session";
import { createBashTool } from "@koi/tools-bash";
import { createBuiltinSearchProvider, createTodoTool, type TodoItem } from "@koi/tools-builtin";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import type { StartFlags } from "../args/start.js";
import { budgetConfigForModel } from "../engine-adapter.js";
import { resolveApiConfig } from "../env.js";
import { loadManifestConfig } from "../manifest.js";
import { createOAuthAwareMcpConnection } from "../mcp-connection-factory.js";
import { loadPluginComponents } from "../plugin-activation.js";
import { ExitCode } from "../types.js";

const DEFAULT_MAX_TURNS = 10;
/**
 * Hard cap on interactive session turns.
 * Limits transcript growth and prevents unbounded context-window expansion.
 */
const MAX_INTERACTIVE_TURNS = 50;
/** JSONL transcript files are stored at ~/.koi/sessions/<sessionId>.jsonl */
const SESSIONS_DIR = join(homedir(), ".koi", "sessions");
/** Optional hooks config path — loaded if present, silently skipped otherwise. */
const HOOKS_CONFIG_PATH = join(homedir(), ".koi", "hooks.json");

// ---------------------------------------------------------------------------
// Tool / middleware builders
// ---------------------------------------------------------------------------

/**
 * Wrap a single Tool as a ComponentProvider so it can be passed to createKoi.
 * The provider name matches the tool name for debug clarity.
 */
function wrapToolAsProvider(tool: import("@koi/core").Tool): ComponentProvider {
  const name = tool.descriptor.name;
  return {
    name,
    attach: async (): Promise<ReadonlyMap<string, unknown>> =>
      new Map([[toolToken(name) as unknown as string, tool]]),
  };
}

/**
 * Build the static ComponentProviders wired into every session:
 *   - builtin search (Glob, Grep)
 *   - web_fetch
 *   - Bash
 *   - TodoWrite (task list tracker — no permission gating needed)
 *
 * NOTE: EnterPlanMode, ExitPlanMode, and AskUserQuestion are intentionally
 * NOT wired here. Plan-mode requires a permission backend that can enforce
 * the read-only gate (deny Write/Edit/Bash until the plan is approved).
 * Without that gate, exposing EnterPlanMode/ExitPlanMode is misleading —
 * the mode flag would flip but no permissions would actually be restricted.
 * The TUI harness wires the full interaction provider (including plan-mode)
 * because it has a real permission backend. `koi start` uses TodoWrite only.
 */
async function buildStaticProviders(cwd: string): Promise<ComponentProvider[]> {
  const searchProvider = createBuiltinSearchProvider({ cwd });
  const webExecutor = createWebExecutor({ allowHttps: true });
  const webProvider = createWebProvider({
    executor: webExecutor,
    policy: DEFAULT_UNSANDBOXED_POLICY,
    operations: ["fetch"],
  });
  const bashProvider = wrapToolAsProvider(createBashTool({ workspaceRoot: cwd }));

  // let: mutable todo list, replaced atomically on each write
  let todoItems: readonly TodoItem[] = [];
  const todoTool = createTodoTool({
    getItems: () => todoItems,
    setItems: (items) => {
      todoItems = items;
    },
  });
  const todoProvider = wrapToolAsProvider(todoTool);

  return [searchProvider, webProvider, bashProvider, todoProvider];
}

/**
 * Load an optional MCP ComponentProvider from `.mcp.json` in `cwd`.
 * Returns undefined (no error) when the file is absent or unreadable.
 */
async function loadMcpProvider(cwd: string): Promise<ComponentProvider | undefined> {
  const mcpConfigPath = join(cwd, ".mcp.json");
  const result = await loadMcpJsonFile(mcpConfigPath);
  if (!result.ok) return undefined; // absent or unreadable — silently skip
  if (result.value.servers.length === 0) return undefined;

  const connections = result.value.servers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  return createMcpComponentProvider({ resolver });
}

/**
 * Load an optional hooks middleware from `~/.koi/hooks.json`.
 * Returns undefined when absent, invalid, or empty.
 */
async function loadHookMiddleware(): Promise<KoiMiddleware | undefined> {
  let raw: unknown;
  try {
    raw = await Bun.file(HOOKS_CONFIG_PATH).json();
  } catch {
    return undefined;
  }
  const result = loadRegisteredHooks(raw, "user");
  if (!result.ok || result.value.length === 0) return undefined;
  return createHookMiddleware({ hooks: result.value });
}

/**
 * Build permissions middleware with auto-allow rules (allow everything by default).
 * This wires the permissions infrastructure without blocking any tools.
 * Users can tighten rules by providing a manifest or custom backend.
 */
function buildPermissionsMiddleware(): KoiMiddleware {
  const backend = createPatternPermissionBackend({
    rules: { allow: ["*"], deny: [], ask: [] },
  });
  return createPermissionsMiddleware({ backend });
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(flags: StartFlags): Promise<ExitCode> {
  // Dry-run not yet implemented — fail closed so no live API calls are made.
  if (flags.dryRun) {
    process.stderr.write(`koi start: --dry-run is not yet supported (tracking: #1264)\n`);
    return ExitCode.FAILURE;
  }

  // JSON log format not yet implemented — fail closed so operators don't silently
  // receive plain text when machine-parseable output was requested.
  if (flags.logFormat === "json") {
    process.stderr.write(`koi start: --log-format json is not yet supported (tracking: #1264)\n`);
    return ExitCode.FAILURE;
  }

  // ---------------------------------------------------------------------------
  // 1. Manifest loading — EAGER, before any adapter creation (fail fast)
  // ---------------------------------------------------------------------------

  let manifestModelName: string | undefined;
  let manifestInstructions: string | undefined;
  if (flags.manifest !== undefined) {
    const manifestResult = await loadManifestConfig(flags.manifest);
    if (!manifestResult.ok) {
      process.stderr.write(`koi start: invalid manifest — ${manifestResult.error}\n`);
      return ExitCode.FAILURE;
    }
    manifestModelName = manifestResult.value.modelName;
    manifestInstructions = manifestResult.value.instructions;
  }

  // ---------------------------------------------------------------------------
  // 2. API configuration
  // ---------------------------------------------------------------------------

  const apiConfigResult = resolveApiConfig();
  if (!apiConfigResult.ok) {
    process.stderr.write(`koi start: ${apiConfigResult.error}\n`);
    return ExitCode.FAILURE;
  }
  const apiConfig = apiConfigResult.value;

  // Manifest model name takes precedence over env-var default.
  const model = manifestModelName ?? apiConfig.model;

  const modelAdapter = createOpenAICompatAdapter({
    apiKey: apiConfig.apiKey,
    ...(apiConfig.baseUrl !== undefined ? { baseUrl: apiConfig.baseUrl } : {}),
    model,
  });

  // ---------------------------------------------------------------------------
  // 3. Session setup — resume or new
  // ---------------------------------------------------------------------------

  const jsonlTranscript = createJsonlTranscript({ baseDir: SESSIONS_DIR });

  // Mutable transcript shared across all stream() calls.
  // Pre-populated on resume; grows across interactive turns.
  // let: justified — grows across turns, never replaced
  const transcript: InboundMessage[] = [];

  let sid = sessionId(crypto.randomUUID());

  if (flags.resume !== undefined) {
    const resumeSid = sessionId(flags.resume);
    const resumeResult = await resumeForSession(resumeSid, jsonlTranscript);
    if (!resumeResult.ok) {
      process.stderr.write(
        `koi start: cannot resume session "${flags.resume}" — ${resumeResult.error.message}\n`,
      );
      return ExitCode.FAILURE;
    }
    // Pre-populate transcript with the loaded session history.
    for (const msg of resumeResult.value.messages) {
      transcript.push(msg);
    }
    sid = resumeSid;
    if (flags.verbose && resumeResult.value.issues.length > 0) {
      process.stderr.write(
        `koi start: resumed with ${resumeResult.value.issues.length} repair issue(s)\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Engine adapter — model→tool→model loop via runTurn
  // ---------------------------------------------------------------------------

  // Wrap ModelAdapter in an EngineAdapter so createKoi can compose middleware.
  // terminals expose modelCall/modelStream so middleware (event-trace, etc.) can intercept.
  // stream() drives the full model→tool→model agent loop via runTurn.
  const engineAdapter: EngineAdapter = {
    engineId: "koi-cli",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: modelAdapter.complete,
      modelStream: modelAdapter.stream,
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const handlers = input.callHandlers;
      if (handlers === undefined) {
        throw new Error("callHandlers required — createKoi must inject them");
      }
      const text = input.kind === "text" ? input.text : "";
      // Stage user message — only committed to transcript after a completed turn.
      const stagedUserMsg: InboundMessage = {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text }],
      };

      // let: accumulated across streaming chunks, read after loop completes
      let deltaText = "";
      let doneContentText = "";

      return (async function* (): AsyncIterable<EngineEvent> {
        // Token-aware compaction — replaces naive message-count slice.
        // budgetConfigForModel resolves context window from @koi/model-registry
        // (e.g. claude-opus-4-6 → 1M, gpt-4o → 128K, unknown → 200K default).
        const budgetResult = await enforceBudget(
          [...transcript],
          undefined,
          budgetConfigForModel(model),
        );
        if (budgetResult.compaction !== "noop") {
          transcript.splice(0, transcript.length, ...budgetResult.messages);
        }
        const contextWindow = [...budgetResult.messages, stagedUserMsg];

        for await (const event of runTurn({
          callHandlers: handlers,
          messages: contextWindow,
          signal: input.signal,
          maxTurns: DEFAULT_MAX_TURNS,
        })) {
          yield event;
          if (event.kind === "text_delta") {
            deltaText += event.delta;
          }
          if (event.kind === "done") {
            doneContentText = event.output.content
              .filter((b) => b.kind === "text")
              .map((b) => (b as { readonly kind: "text"; readonly text: string }).text)
              .join("");
            if (event.output.stopReason === "completed") {
              const assistantText = doneContentText.length > 0 ? doneContentText : deltaText;
              transcript.push(stagedUserMsg);
              if (assistantText.length > 0) {
                transcript.push({
                  senderId: "assistant",
                  timestamp: Date.now(),
                  content: [{ kind: "text", text: assistantText }],
                });
              }
            }
          }
        }
      })();
    },
  };

  // ---------------------------------------------------------------------------
  // 5. Tool and middleware assembly (parallel async loading)
  // ---------------------------------------------------------------------------

  const cwd = process.cwd();
  const pluginUserRoot = join(homedir(), ".koi", "plugins");
  const [mcpProvider, hookMiddleware, staticProviders, pluginComponents] = await Promise.all([
    loadMcpProvider(cwd),
    loadHookMiddleware(),
    buildStaticProviders(cwd),
    loadPluginComponents(pluginUserRoot),
  ]);

  // Log plugin activation errors (non-fatal)
  for (const err of pluginComponents.errors) {
    console.warn(`[koi start] plugin "${err.plugin}": ${err.error}`);
  }
  if (pluginComponents.middlewareNames.length > 0) {
    console.warn(
      `[koi start] ${String(pluginComponents.middlewareNames.length)} plugin middleware name(s) skipped (no factory registry): ${pluginComponents.middlewareNames.join(", ")}`,
    );
  }

  // Plugin MCP provider (additional MCP servers from installed plugins)
  let pluginMcpProvider: ComponentProvider | undefined;
  if (pluginComponents.mcpServers.length > 0) {
    const connections = pluginComponents.mcpServers.map((server) =>
      createOAuthAwareMcpConnection(server),
    );
    const resolver = createMcpResolver(connections);
    pluginMcpProvider = createMcpComponentProvider({ resolver });
  }

  // Plugin hooks merged into hook middleware with tier tagging:
  // user hooks = "user" tier, plugin hooks = "session" tier.
  let mergedHookMiddleware = hookMiddleware;
  if (pluginComponents.hooks.length > 0) {
    const pluginRegistered = createRegisteredHooks(pluginComponents.hooks, "session");
    if (hookMiddleware !== undefined) {
      // Rebuild with merged hooks (user hooks loaded via loadHookMiddleware don't
      // expose the underlying array, so re-load user hooks and merge)
      const userHooksPath = join(homedir(), ".koi", "hooks.json");
      let userRegistered: readonly import("@koi/hooks").RegisteredHook[] = [];
      try {
        const raw: unknown = await Bun.file(userHooksPath).json();
        const result = loadRegisteredHooks(raw, "user");
        if (result.ok) userRegistered = result.value;
      } catch {
        // Already loaded above — fallback to empty
      }
      mergedHookMiddleware = createHookMiddleware({
        hooks: [...userRegistered, ...pluginRegistered],
      });
    } else {
      mergedHookMiddleware = createHookMiddleware({ hooks: pluginRegistered });
    }
  }

  const providers: ComponentProvider[] = [
    ...staticProviders,
    ...(mcpProvider !== undefined ? [mcpProvider] : []),
    ...(pluginMcpProvider !== undefined ? [pluginMcpProvider] : []),
  ];

  const sessionTranscriptMiddleware = createSessionTranscriptMiddleware({
    transcript: jsonlTranscript,
    sessionId: sid,
  });

  const middleware: KoiMiddleware[] = [
    sessionTranscriptMiddleware,
    buildPermissionsMiddleware(),
    ...(mergedHookMiddleware !== undefined ? [mergedHookMiddleware] : []),
    ...(manifestInstructions !== undefined
      ? [createSystemPromptMiddleware(manifestInstructions)]
      : []),
  ];

  // ---------------------------------------------------------------------------
  // 6. Runtime assembly
  // ---------------------------------------------------------------------------

  const runtime = await createKoi({
    manifest: { name: "koi", version: "0.0.1", model: { name: model } },
    adapter: engineAdapter,
    middleware,
    providers,
  });

  const channel = createCliChannel({ theme: "default" });

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
  });

  const harness = createCliHarness({
    runtime,
    channel,
    tui: null,
    signal: controller.signal,
    verbose: flags.verbose,
    maxTurns: MAX_INTERACTIVE_TURNS,
  });

  // ---------------------------------------------------------------------------
  // 7. Execute
  // ---------------------------------------------------------------------------

  switch (flags.mode.kind) {
    case "interactive": {
      try {
        await harness.runInteractive();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`koi: ${msg}\n`);
        return ExitCode.FAILURE;
      }
      break;
    }
    case "prompt": {
      let result: Awaited<ReturnType<typeof harness.runSinglePrompt>>;
      try {
        result = await harness.runSinglePrompt(flags.mode.text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`koi: ${msg}\n`);
        return ExitCode.FAILURE;
      }
      if (result.stopReason !== "completed") {
        return ExitCode.FAILURE;
      }
      break;
    }
  }

  // Non-zero exit for user-cancelled sessions so scripts/automation can
  // distinguish cancellation (SIGINT) from successful completion.
  if (controller.signal.aborted) {
    return ExitCode.FAILURE;
  }

  return ExitCode.OK;
}
