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

import type {
  ComponentProvider,
  EngineEvent,
  EngineInput,
  InboundMessage,
  KoiMiddleware,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { filterResumedMessagesForDisplay } from "@koi/core/message";
import { createKoi } from "@koi/engine";
import { createCliHarness, renderEngineEvent, shouldRender } from "@koi/harness";
import { createArgvGate, type LoopRuntime, runUntilPass } from "@koi/loop";
import {
  createPatternPermissionBackend,
  createPermissionsMiddleware,
} from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { createJsonlTranscript } from "@koi/session";
import { createBashTool } from "@koi/tools-bash";
import { createTodoTool, type TodoItem } from "@koi/tools-builtin";
import type { StartFlags } from "../args/start.js";
import { budgetConfigForModel, createTranscriptAdapter } from "../engine-adapter.js";
import { resolveApiConfig } from "../env.js";
import { loadManifestConfig } from "../manifest.js";
import { loadPluginComponents } from "../plugin-activation.js";
import {
  buildCoreMiddleware,
  buildCoreProviders,
  buildPluginMcpSetup,
  loadUserMcpSetup,
  loadUserRegisteredHooks,
  type McpSetup,
  mergeUserAndPluginHooks,
  resumeSessionFromJsonl,
  wrapToolAsProvider,
} from "../shared-wiring.js";
import { createSigintHandler, createUnrefTimer } from "../sigint-handler.js";
import { ExitCode } from "../types.js";

const DEFAULT_MAX_TURNS = 10;
/**
 * Hard cap on interactive session turns.
 * Limits transcript growth and prevents unbounded context-window expansion.
 */
const MAX_INTERACTIVE_TURNS = 50;
/** JSONL transcript files are stored at ~/.koi/sessions/<sessionId>.jsonl */
const SESSIONS_DIR = join(homedir(), ".koi", "sessions");

// ---------------------------------------------------------------------------
// Tool / middleware builders
// ---------------------------------------------------------------------------

/**
 * Build the ComponentProviders for `koi start` — the shared core (builtin
 * search + filesystem + web + bash from `buildCoreProviders`) plus the
 * CLI-only TodoWrite tracker.
 *
 * NOTE: EnterPlanMode, ExitPlanMode, and AskUserQuestion are intentionally
 * NOT wired here. Plan-mode requires a permission backend that can enforce
 * the read-only gate (deny Write/Edit/Bash until the plan is approved).
 * Without that gate, exposing EnterPlanMode/ExitPlanMode is misleading.
 * The TUI wires the full interaction provider (including plan-mode)
 * because it has a real permission backend.
 */
function buildCliProviders(cwd: string): ComponentProvider[] {
  // let: mutable todo list, replaced atomically on each write
  let todoItems: readonly TodoItem[] = [];
  const todoTool = createTodoTool({
    getItems: () => todoItems,
    setItems: (items) => {
      todoItems = items;
    },
  });

  return buildCoreProviders({
    cwd,
    bashTool: createBashTool({ workspaceRoot: cwd }),
    additional: [wrapToolAsProvider(todoTool)],
  });
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

  // Generation counter for the transcript, incremented whenever loop mode
  // truncates the transcript back to its baseline between iterations. Each
  // stream() invocation captures the current generation at start time; its
  // final transcript.push() compares against the live generation and skips
  // the write if it has advanced. This fences off orphaned iteration
  // streams whose model call completes in the background AFTER the next
  // loop iteration has already started — without that guard, late pushes
  // from a timed-out iteration would pollute iteration N+2's context
  // window. Generation bumps happen via incrementTranscriptGeneration()
  // from runConvergenceLoop's resetTranscript callback.
  // let: mutable — bumped on every loop reset
  let transcriptGeneration = 0;
  const incrementTranscriptGeneration = (): void => {
    transcriptGeneration += 1;
  };

  // let: justified — reassigned once on successful --resume
  let sid = sessionId(crypto.randomUUID());

  if (flags.resume !== undefined) {
    const resumeResult = await resumeSessionFromJsonl(flags.resume, jsonlTranscript, SESSIONS_DIR);
    if (!resumeResult.ok) {
      process.stderr.write(
        `koi start: cannot resume session "${flags.resume}" — ${resumeResult.error}\n`,
      );
      return ExitCode.FAILURE;
    }
    // Pre-populate transcript with the loaded session history.
    for (const msg of resumeResult.value.messages) {
      transcript.push(msg);
    }
    sid = resumeResult.value.sid;
    if (flags.verbose && resumeResult.value.issueCount > 0) {
      process.stderr.write(
        `koi start: resumed with ${resumeResult.value.issueCount} repair issue(s)\n`,
      );
    }
    // Render the loaded history to stdout so the user sees the prior
    // conversation before the next prompt. Filter rules live in
    // `@koi/core/message#filterResumedMessagesForDisplay` so CLI and TUI
    // stay in lockstep — adding a new rule in that one helper updates
    // both hosts at once.
    const displayable = filterResumedMessagesForDisplay(resumeResult.value.messages);
    process.stdout.write(
      `\n── Resumed session ${String(sid)} (${String(displayable.length)} message(s)) ──\n\n`,
    );
    for (const msg of displayable) {
      const text = msg.content.map((b) => (b.kind === "text" ? b.text : `[${b.kind}]`)).join("");
      if (text.length === 0) continue;
      const label = msg.role === "user" ? "You" : "Assistant";
      process.stdout.write(`${label}: ${text}\n\n`);
    }
    process.stdout.write("── End of history ──\n\n");
  }

  // ---------------------------------------------------------------------------
  // 4. Engine adapter — shared `createTranscriptAdapter` factory
  // ---------------------------------------------------------------------------
  //
  // Uses the same transcript-backed EngineAdapter as `koi tui`, so both hosts
  // share: message staging, token-aware budget enforcement (enforceBudget +
  // in-place splice), commit-on-done, and the synthetic-explain path for
  // non-"completed" stop reasons. The loop-mode generation fence (#1624) is
  // threaded in as a `getGeneration` callback — the adapter short-circuits
  // the commit if the outer convergence loop has already moved on.
  const engineAdapter = createTranscriptAdapter({
    engineId: "koi-cli",
    modelAdapter,
    transcript,
    maxTranscriptMessages: 100,
    maxTurns: DEFAULT_MAX_TURNS,
    budgetConfig: budgetConfigForModel(model),
    getGeneration: () => transcriptGeneration,
  });

  // ---------------------------------------------------------------------------
  // 5. Tool and middleware assembly (parallel async loading)
  // ---------------------------------------------------------------------------

  const cwd = process.cwd();
  const pluginUserRoot = join(homedir(), ".koi", "plugins");
  // `koi start` does not pass a SkillsRuntime, so MCP tools stay in the
  // MCP provider and are never bridged into the skills registry — matches
  // the prior loadMcpProvider() behavior verbatim.
  const [mcpSetup, userHooks, pluginComponents] = await Promise.all([
    loadUserMcpSetup(cwd, undefined),
    loadUserRegisteredHooks({ filterAgentHooks: false }),
    loadPluginComponents(pluginUserRoot),
  ]);
  const staticProviders = buildCliProviders(cwd);

  // Log plugin activation errors (non-fatal)
  for (const err of pluginComponents.errors) {
    console.warn(`[koi start] plugin "${err.plugin}": ${err.error}`);
  }
  if (pluginComponents.middlewareNames.length > 0) {
    console.warn(
      `[koi start] ${String(pluginComponents.middlewareNames.length)} plugin middleware name(s) skipped (no factory registry): ${pluginComponents.middlewareNames.join(", ")}`,
    );
  }

  const pluginMcpSetup: McpSetup | undefined = buildPluginMcpSetup(pluginComponents.mcpServers);

  // User hooks (user tier) come first; plugin hooks (session tier) are
  // appended — same merge order the old inline block produced.
  const allHooks = mergeUserAndPluginHooks(userHooks, pluginComponents.hooks, {
    filterAgentHooks: false,
  });

  const providers: ComponentProvider[] = [
    ...staticProviders,
    ...(mcpSetup !== undefined ? [mcpSetup.provider] : []),
    ...(pluginMcpSetup !== undefined ? [pluginMcpSetup.provider] : []),
  ];

  // In loop mode (--until-pass), session-transcript persistence is
  // intentionally disabled. Every iteration would otherwise write a new
  // entry to the JSONL session log, so a later `koi start --resume <id>`
  // would replay all failed attempts as part of the user context.
  const isLoopMode = flags.mode.kind === "prompt" && flags.untilPass.length > 0;
  const slots = buildCoreMiddleware({
    permissionsMiddleware: buildPermissionsMiddleware(),
    hooks: allHooks,
    systemPrompt: manifestInstructions,
    ...(isLoopMode ? {} : { session: { transcript: jsonlTranscript, sessionId: sid } }),
  });
  // CLI middleware order (outermost → innermost):
  //   session-transcript → permissions → hook → system-prompt
  const middleware: KoiMiddleware[] = [
    ...(slots.sessionTranscript !== undefined ? [slots.sessionTranscript] : []),
    slots.permissions,
    ...(slots.hook !== undefined ? [slots.hook] : []),
    ...(slots.systemPrompt !== undefined ? [slots.systemPrompt] : []),
  ];

  // ---------------------------------------------------------------------------
  // 6. Runtime assembly
  // ---------------------------------------------------------------------------

  // Engine loop detection is LEFT ON in loop mode.
  //
  // Round 33 (this review session) speculated that the engine-level
  // loop detector would accumulate state across retries and cause
  // false positives. Round 34 flipped and argued that disabling it
  // leaves each individual iteration unbounded — a single bad
  // iteration could hammer tools until the 10-minute iteration
  // timeout fired.
  //
  // Reverting to the default (enabled) because:
  //   1. Loop detection is per-runTurn, not per-runtime. Each
  //      iteration calls runtime.run() which triggers a fresh
  //      runTurn invocation, and the detector's state is scoped to
  //      that invocation. No cross-iteration state leak in practice.
  //   2. The round 34 concern is more specific and more expensive
  //      to get wrong: an iteration that enters a tool-calling
  //      spiral would burn tokens and potentially side-effecting
  //      tool calls until iterationTimeoutMs fires.
  //   3. If the round 33 concern materializes, users can disable
  //      it explicitly by building their own runtime; the default
  //      stays safe.
  // Thread the resolved session id (`sid`) into createKoi as the
  // factory-level override so the engine routes the session-transcript
  // middleware to the SAME JSONL file we already pre-populated with
  // the resumed messages. Without this, the runtime mints a fresh
  // `agent:{agentId}:{uuid}` internally and new turns get written to
  // a different file — the printed `--resume` command then resumes a
  // partial session that is missing everything after the fork point.
  // Skipped in loop mode because loop mode intentionally disables
  // session-transcript persistence entirely (see isLoopMode above).
  const runtime = await createKoi({
    manifest: { name: "koi", version: "0.0.1", model: { name: model } },
    adapter: engineAdapter,
    middleware,
    providers,
    ...(isLoopMode ? {} : { sessionId: sid }),
  });

  const channel = createCliChannel({ theme: "default" });

  const controller = new AbortController();
  // `stay-armed` policy (the default): once the user presses Ctrl+C, the
  // harness uses a single session-wide `AbortSignal` that stays aborted
  // forever. The interactive loop breaks out of `runInteractive()` and the
  // session ends — there is no "fresh turn" to re-arm for. Staying armed
  // means any subsequent Ctrl+C during post-cancel teardown forces exit,
  // which is the escape hatch we want.
  //
  // `failsafeMs: 30_000` is a generous budget covering normal post-abort
  // teardown (channel disconnect, runtime dispose, transcript flush) while
  // still catching a genuinely non-cooperative tool or stream consumer
  // that ignores the abort signal indefinitely. Without a failsafe, a
  // non-cooperative run leaves the session hung and the user needs to
  // double-tap to escape; with 30s, even a lazy tool gets plenty of time
  // to settle before we hard-exit.
  const sigintHandler = createSigintHandler({
    onGraceful: () => {
      controller.abort();
    },
    onForce: () => {
      process.exit(130);
    },
    write: (msg: string) => {
      process.stderr.write(msg);
    },
    doubleTapWindowMs: 2000,
    failsafeMs: 30_000,
    setTimer: createUnrefTimer,
  });
  const onSigint = (): void => {
    sigintHandler.handleSignal();
  };
  process.on("SIGINT", onSigint);

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

  try {
    switch (flags.mode.kind) {
      case "interactive": {
        try {
          await harness.runInteractive();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`koi: ${msg}\n`);
          return ExitCode.FAILURE;
        } finally {
          await runtime.dispose?.();
        }
        break;
      }
      case "prompt": {
        // Convergence loop mode (#1624): repeat runtime.run() until the verifier
        // passes or a budget is exhausted. Bypasses the harness entirely — the
        // harness contract says runSinglePrompt is safe to call once, and loop
        // mode needs N iterations through a live runtime.
        if (flags.untilPass.length > 0) {
          // Runtime warning printed on every loop-mode entry so the user is
          // reminded of the trust-boundary implications even after they've
          // passed --allow-side-effects (which is only checked at parse time).
          // Goes to stderr so it doesn't pollute stdout-captured output.
          process.stderr.write(
            [
              "koi: loop mode enabled — non-idempotent tools will run on every retry,",
              "     and the verifier subprocess executes outside the CLI permission model.",
              `     max-iter=${flags.maxIter}, verifier-timeout=${flags.verifierTimeoutMs}ms`,
              "",
            ].join("\n"),
          );

          // Preserve any pre-existing transcript (e.g. from --resume) as the
          // baseline. Each iteration truncates back to this baseline, so the
          // model sees:
          //   [resumed history... + this iteration's rebuilt prompt]
          // and never:
          //   [resumed history... + iter1 turn + iter2 turn + ...]
          // which would pollute retries with stale assistant replies. The
          // rebuilt prompt from @koi/loop already carries the latest failure
          // forward into the next attempt (#1624 review finding).
          const transcriptBaseline = transcript.length;
          try {
            const loopResult = await runConvergenceLoop({
              runtime,
              prompt: flags.mode.text,
              untilPassArgv: flags.untilPass,
              maxIterations: flags.maxIter,
              verifierTimeoutMs: flags.verifierTimeoutMs,
              workingDir: process.cwd(),
              verbose: flags.verbose,
              signal: controller.signal,
              verifierInheritEnv: flags.verifierInheritEnv,
              resetTranscript: () => {
                transcript.length = transcriptBaseline;
                // Bump the generation so any orphaned iteration stream
                // that finally produces its done event in the background
                // cannot push stale turns onto the next iteration's
                // transcript view (#1624 round-12 review fix).
                incrementTranscriptGeneration();
              },
            });
            if (loopResult.status !== "converged") {
              process.stderr.write(
                `koi: loop ended in '${loopResult.status}' state after ${loopResult.iterations} iteration(s): ${loopResult.terminalReason}\n`,
              );
              return ExitCode.FAILURE;
            }
            process.stdout.write(
              `\nkoi: loop converged after ${loopResult.iterations} iteration(s)\n`,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`koi: ${msg}\n`);
            return ExitCode.FAILURE;
          } finally {
            await runtime.dispose?.();
          }
          break;
        }

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
  } finally {
    sigintHandler.dispose();
    process.removeListener("SIGINT", onSigint);
  }
}

// ---------------------------------------------------------------------------
// Convergence loop driver (#1624 — @koi/loop)
// ---------------------------------------------------------------------------

interface ConvergenceLoopOptions {
  readonly runtime: { readonly run: (input: EngineInput) => AsyncIterable<EngineEvent> };
  readonly prompt: string;
  readonly untilPassArgv: readonly string[];
  readonly maxIterations: number;
  readonly verifierTimeoutMs: number;
  readonly workingDir: string;
  readonly verbose: boolean;
  readonly signal: AbortSignal;
  /**
   * When true, the verifier inherits the parent env (minus Koi provider
   * keys via scrubSensitiveEnv). When false (default), the verifier gets
   * only createArgvGate's minimal allowlist.
   */
  readonly verifierInheritEnv: boolean;
  /**
   * Called immediately before each iteration's runtime.run() delegation.
   * Used by the CLI to truncate the shared agent transcript so retries start
   * from a clean context window instead of carrying the previous failed
   * attempt forward as an assistant turn.
   */
  readonly resetTranscript?: () => void;
}

/**
 * Drive runUntilPass() with live stdout streaming.
 *
 * The tee-runtime wraps the real runtime so that every EngineEvent is both
 * yielded to the loop (which feeds @koi/loop's iteration tracker) and
 * rendered to stdout via @koi/harness's existing event renderer. This keeps
 * the UX identical to single-prompt mode while letting the loop own the
 * iteration lifecycle.
 */
async function runConvergenceLoop(
  opts: ConvergenceLoopOptions,
): Promise<Awaited<ReturnType<typeof runUntilPass>>> {
  const {
    runtime,
    prompt,
    untilPassArgv,
    maxIterations,
    verifierTimeoutMs,
    workingDir,
    verbose,
    signal,
    resetTranscript,
    verifierInheritEnv,
  } = opts;

  // Validate the argv upfront so createArgvGate's tuple-type guard is satisfied.
  if (untilPassArgv.length === 0) {
    throw new Error("runConvergenceLoop: untilPassArgv must be non-empty");
  }
  const argv: readonly [string, ...string[]] = [
    untilPassArgv[0] as string,
    ...untilPassArgv.slice(1),
  ];

  // Tee-runtime: forwards events to the loop AND streams them to stdout.
  // Each iteration starts by resetting the shared transcript (when a reset
  // callback is provided) so the model sees only the rebuilt prompt for the
  // current attempt — no accumulation of prior failed turns.
  const output = process.stdout;
  const teeRuntime: LoopRuntime = {
    async *run(input) {
      resetTranscript?.();
      let hasPriorDeltas = false;
      for await (const event of runtime.run({
        kind: input.kind,
        text: input.text,
        signal: input.signal,
      })) {
        if (event.kind === "text_delta" && event.delta.length > 0) hasPriorDeltas = true;
        if (shouldRender(event, verbose)) {
          const line = renderEngineEvent(event, verbose, hasPriorDeltas && event.kind === "done");
          if (line !== null) output.write(line);
        }
        yield event;
      }
    },
  };

  // Environment policy for the verifier subprocess:
  //
  //   Default (verifierInheritEnv === false):
  //     Pass nothing — createArgvGate falls back to its minimal allowlist
  //     (PATH, HOME, USER, LANG, TERM, TMPDIR, SHELL, LC_*). Project
  //     secrets like DATABASE_URL, GITHUB_TOKEN, AWS_ACCESS_KEY_ID, etc.
  //     never reach verifier code the agent may have just modified.
  //
  //   Opt-in (--verifier-inherit-env):
  //     Forward the parent env minus Koi's provider keys. This is what
  //     real test suites that depend on project env vars need (NEXTAUTH_
  //     SECRET, STRIPE_SECRET_KEY, DB_PASSWORD, etc.) and matches the
  //     pre-round-28 CLI default. Users have explicitly acknowledged
  //     the trade-off by passing the flag.
  //
  // Secure-by-default resolves the 10+ round oscillation on verifier
  // env handling: the library-level hardening is no longer defeated
  // at the first shipping entrypoint, and users who legitimately need
  // project env passthrough have a documented opt-in.
  const verifier = createArgvGate(argv, {
    cwd: workingDir,
    timeoutMs: verifierTimeoutMs,
    ...(verifierInheritEnv ? { env: scrubSensitiveEnv(process.env) } : {}),
  });

  // Display only the verifier binary name (argv[0]). Full argv may contain
  // tokens, URLs with credentials, or private paths — never echo it back
  // through logs or the model prompt (#1624 review finding).
  const verifierName = argv[0];

  return runUntilPass({
    runtime: teeRuntime,
    verifier,
    initialPrompt: prompt,
    workingDir,
    maxIterations,
    verifierTimeoutMs,
    // Circuit breaker is effectively disabled in CLI mode — --max-iter
    // is the binding constraint, not the consecutive-failure breaker.
    //
    // This has oscillated across review rounds:
    //
    //   1. Original: library default (3) was the real cap. Users who
    //      set --max-iter 10 got circuit_broken after 3 attempts and
    //      were surprised.
    //   2. Round 10 fix: tied breaker to --max-iter. Restored the
    //      iteration budget as the binding constraint, BUT the state
    //      machine checks the breaker BEFORE the iteration budget, so
    //      when the two fire at the same iteration the terminal status
    //      was circuit_broken instead of the expected exhausted.
    //   3. Round 27 fix (this): make the breaker unreachable in CLI
    //      mode so the iteration budget is always the reported cause
    //      of exhaustion. The library-level breaker stays available to
    //      direct @koi/loop consumers who want the stuck-loop diagnosis.
    maxConsecutiveFailures: Number.MAX_SAFE_INTEGER,
    signal,
    onEvent: (event) => {
      if (event.kind === "loop.iteration.start") {
        output.write(`\n--- loop iteration ${event.iteration} / ${maxIterations} ---\n`);
      } else if (event.kind === "loop.verifier.complete") {
        if (event.result.ok) {
          output.write(`✔ verifier passed (${verifierName})\n`);
        } else {
          const reason = event.result.reason;
          output.write(`✘ verifier failed: ${reason}\n`);
        }
      }
    },
  });
}

/**
 * Remove Koi's provider credentials from the environment before handing
 * it to a --until-pass verifier subprocess. Only the CLI's own model
 * credentials are blocked; every other environment variable flows through
 * unchanged. That is deliberate:
 *
 * - The goal is to prevent Koi's API keys from reaching an arbitrary
 *   user-supplied subprocess, not to sanitize the entire environment.
 * - Real-world verifiers (bun test, pytest, make) routinely need the
 *   project's own secrets — NEXTAUTH_SECRET, STRIPE_SECRET_KEY,
 *   SLACK_BOT_TOKEN, DB_PASSWORD, etc. Stripping those by name pattern
 *   would break legitimate test runs that pass outside loop mode.
 * - If a caller needs a tighter sandbox, they can build their own
 *   Verifier and pass an explicit env policy.
 *
 * Blocked list only covers the exact names the CLI reads from env.ts
 * (OPENROUTER_API_KEY / OPENAI_API_KEY) plus the other major provider
 * credentials a future Koi adapter might adopt.
 *
 * Exported for unit testing.
 */
export function scrubSensitiveEnv(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const blockedExact = new Set<string>([
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
  ]);

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (blockedExact.has(k)) continue;
    result[k] = v;
  }
  return result;
}
