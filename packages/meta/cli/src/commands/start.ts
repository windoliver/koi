/**
 * `koi start` — run agent in interactive REPL or single-prompt mode.
 *
 * Wires @koi/harness → @koi/engine (createKoi) → @koi/model-openai-compat
 * with @koi/channel-cli for I/O.
 *
 * Env vars:
 *   OPENROUTER_API_KEY   — Required. OpenRouter API key for model access.
 *
 * No tools are attached by default. Tool access requires a manifest
 * (--manifest, not yet implemented, tracking: #1264).
 */

import { createAgentResolver } from "@koi/agent-runtime";
import { createCliChannel } from "@koi/channel-cli";
import type { EngineAdapter, EngineEvent, EngineInput, InboundMessage } from "@koi/core";
import { createInMemorySpawnLedger, createKoi, createSpawnToolProvider } from "@koi/engine";
import { DEFAULT_SPAWN_POLICY } from "@koi/engine-compose";
import { createCliHarness } from "@koi/harness";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { runTurn } from "@koi/query-engine";
import type { StartFlags } from "../args/start.js";
import { ExitCode } from "../types.js";

const DEFAULT_MODEL = "google/gemini-2.0-flash-001";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Conservative cap: prevents runaway model/tool loops on live API calls. */
const DEFAULT_MAX_TURNS = 10;
/**
 * Hard cap on interactive session turns.
 * Limits transcript growth and prevents unbounded context-window expansion.
 */
const MAX_INTERACTIVE_TURNS = 50;
/**
 * Max transcript messages retained for context.
 * Keeps the most recent N messages to avoid exceeding provider context limits.
 */
const MAX_TRANSCRIPT_MESSAGES = 20;

export async function run(flags: StartFlags): Promise<ExitCode> {
  // Session resume — blocked on @koi/session (#1504)
  if (flags.resume !== undefined) {
    process.stderr.write(`koi start: session resume is not yet available (tracking: #1504)\n`);
    return ExitCode.FAILURE;
  }

  // Manifest loading not yet implemented — reject to prevent silently using the
  // path string as a model name (which would produce a confusing API error).
  if (flags.manifest !== undefined) {
    process.stderr.write(`koi start: --manifest is not yet supported (tracking: #1264)\n`);
    return ExitCode.FAILURE;
  }

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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write(`koi start: no API key found — set OPENROUTER_API_KEY\n`);
    return ExitCode.FAILURE;
  }

  const model = DEFAULT_MODEL;

  const modelAdapter = createOpenAICompatAdapter({
    apiKey,
    baseUrl: OPENROUTER_BASE_URL,
    model,
  });

  // Mutable transcript shared across all stream() calls.
  // Persists user messages and assistant replies between interactive turns so
  // the model retains prior conversation context.
  // let: justified — grows across turns, never replaced
  const transcript: InboundMessage[] = [];

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
      // Committing early would leave orphaned user prompts on failure, breaking retry semantics.
      const stagedUserMsg: InboundMessage = {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text }],
      };

      // Capture assistant reply from both delta stream and authoritative done.output.content.
      // Providers may finalize in done.output.content rather than (or in addition to) deltas.
      let deltaText = "";
      let doneContentText = "";

      // Build context window including the staged user message so runTurn sees the full
      // conversation, but do not push to transcript until the turn completes successfully.
      const contextWindow = [...transcript.slice(-MAX_TRANSCRIPT_MESSAGES), stagedUserMsg];

      return (async function* (): AsyncIterable<EngineEvent> {
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
            // Only persist completed turns — non-completed turns must not corrupt the transcript.
            // Commit the staged user message and assistant reply atomically so a failed turn
            // leaves no orphaned user prompt for the next turn's context window.
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

  // Wire agent-runtime: load built-ins + project custom agents from .koi/agents/
  const { resolver: agentResolver, warnings: agentWarnings } = createAgentResolver({
    projectDir: process.cwd(),
  });
  for (const w of agentWarnings) {
    process.stderr.write(`[koi] agent load warning: ${w.error.message} (${w.filePath})\n`);
  }
  const spawnProvider = createSpawnToolProvider({
    resolver: agentResolver,
    spawnLedger: createInMemorySpawnLedger(DEFAULT_SPAWN_POLICY.maxTotalProcesses),
    adapter: engineAdapter,
    manifestTemplate: {
      name: "spawned-agent",
      version: "0.0.0",
      description: "Spawned sub-agent",
      model: { name: model },
    },
    spawnPolicy: DEFAULT_SPAWN_POLICY,
  });

  const runtime = await createKoi({
    manifest: { name: "koi", version: "0.0.1", model: { name: model } },
    adapter: engineAdapter,
    providers: [spawnProvider],
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

  switch (flags.mode.kind) {
    case "interactive": {
      try {
        await harness.runInteractive();
      } catch (err: unknown) {
        // Engine stream errors (e.g. truncated stream, adapter bug) propagate here.
        // Print to stderr and fail closed — matching single-prompt error semantics.
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
