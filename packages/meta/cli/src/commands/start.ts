/**
 * `koi start` — run agent in interactive REPL or single-prompt mode.
 *
 * Wires @koi/harness → @koi/engine (createKoi) → @koi/model-openai-compat
 * with @koi/channel-cli for I/O. Sessions are persisted to JSONL transcripts
 * at ~/.koi/sessions/<sessionId>.jsonl and can be resumed with --resume.
 *
 * API key resolution: OPENROUTER_API_KEY or OPENAI_API_KEY (see env.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import type { EngineAdapter, EngineEvent, EngineInput, InboundMessage } from "@koi/core";
import { sessionId } from "@koi/core";
import { createKoi, createSystemPromptMiddleware } from "@koi/engine";
import { createCliHarness } from "@koi/harness";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { runTurn } from "@koi/query-engine";
import {
  createJsonlTranscript,
  createSessionTranscriptMiddleware,
  resumeForSession,
} from "@koi/session";
import type { StartFlags } from "../args/start.js";
import { resolveApiConfig } from "../env.js";
import { loadManifestConfig } from "../manifest.js";
import { ExitCode } from "../types.js";

const DEFAULT_MAX_TURNS = 10;
/**
 * Hard cap on interactive session turns.
 * Limits transcript growth and prevents unbounded context-window expansion.
 */
const MAX_INTERACTIVE_TURNS = 50;
/** JSONL transcript files are stored at ~/.koi/sessions/<sessionId>.jsonl */
const SESSIONS_DIR = join(homedir(), ".koi", "sessions");

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

  const contextWindowSize = flags.contextWindow;

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

      let deltaText = "";
      let doneContentText = "";
      const contextWindow = [...transcript.slice(-contextWindowSize), stagedUserMsg];

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
  // 5. Runtime assembly
  // ---------------------------------------------------------------------------

  const sessionTranscriptMiddleware = createSessionTranscriptMiddleware({
    transcript: jsonlTranscript,
    sessionId: sid,
  });

  const runtime = await createKoi({
    manifest: { name: "koi", version: "0.0.1", model: { name: model } },
    adapter: engineAdapter,
    middleware: [
      sessionTranscriptMiddleware,
      ...(manifestInstructions !== undefined
        ? [createSystemPromptMiddleware(manifestInstructions)]
        : []),
    ],
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
  // 6. Execute
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
