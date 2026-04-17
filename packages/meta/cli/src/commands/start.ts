/**
 * `koi start` — run agent in interactive REPL or single-prompt mode.
 *
 * Shares one runtime factory with `koi tui`: both commands call
 * `createKoiRuntime` from `../runtime-factory.js` and differ only in
 * their I/O loop (CLI uses `@koi/harness`'s plain-stdout channel;
 * TUI uses OpenTUI). Adding a new middleware, tool, or provider to
 * the factory automatically lands in both hosts.
 *
 * API key resolution: OPENROUTER_API_KEY or OPENAI_API_KEY (see env.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import type {
  ApprovalHandler,
  EngineEvent,
  EngineInput,
  FileSystemBackend,
  InboundMessage,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { filterResumedMessagesForDisplay } from "@koi/core/message";
import { createCliHarness, renderEngineEvent, shouldRender } from "@koi/harness";
import { createArgvGate, type LoopRuntime, runUntilPass } from "@koi/loop";
import { createPatternPermissionBackend } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { resolveFileSystem } from "@koi/runtime";
import { createJsonlTranscript } from "@koi/session";
import type { StartFlags } from "../args/start.js";
import { resolveApiConfig } from "../env.js";
import { loadManifestConfig } from "../manifest.js";
import { initOtelSdk } from "../otel-bootstrap.js";
import { DEFAULT_STACKS } from "../preset-stacks.js";
import { createKoiRuntime } from "../runtime-factory.js";
import { resumeSessionFromJsonl } from "../shared-wiring.js";
import { createSigintHandler, createUnrefTimer } from "../sigint-handler.js";
import { ExitCode } from "../types.js";

/**
 * Hard cap on interactive session turns.
 * Limits transcript growth and prevents unbounded context-window expansion.
 */
const MAX_INTERACTIVE_TURNS = 50;
/** JSONL transcript files are stored at ~/.koi/sessions/<sessionId>.jsonl */
const SESSIONS_DIR = join(homedir(), ".koi", "sessions");

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

/**
 * Non-interactive auto-approve handler. `koi start` pairs this with the
 * auto-allow permission backend so the runtime never actually blocks on
 * an approval — the backend allows everything up front, so this handler
 * is only called if something bypasses the backend gate. Returning
 * `always-allow` matches the old CLI posture.
 */
const autoApproveHandler: ApprovalHandler = async () => ({
  kind: "always-allow",
  scope: "session",
});

/**
 * Default preset-stack set for `koi start`: every stack except
 * `spawn`. Removing the spawn stack eliminates the coordinator
 * pattern from the CLI, which removes the `task_output` polling
 * flow that would otherwise trip the default loop detector's
 * 3-in-8 threshold. Matches main's pre-refactor capability
 * surface: no sub-agents, no polling, no detector false positives.
 *
 * Users who really want coordinator workflows under `koi start`
 * opt back in via an explicit `manifest.stacks` list that includes
 * "spawn" — at which point they're acknowledging the loop-detector
 * false-positive risk themselves.
 *
 * Computed lazily from `DEFAULT_STACKS` so any new stack added to
 * the registry appears here automatically (stacks default to
 * on-for-start unless they explicitly exclude themselves the way
 * spawn does here).
 */
const DEFAULT_STACKS_WITHOUT_SPAWN: readonly string[] = DEFAULT_STACKS.filter(
  (stack) => stack.id !== "spawn",
).map((stack) => stack.id);

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
  let manifestStacks: readonly string[] | undefined;
  let manifestPlugins: readonly string[] | undefined;
  // #1777: the manifest filesystem block is parsed+validated by
  // `loadManifestConfig` (see manifest.ts). `koi start` supports
  // `backend: "local"` on the host-default local backend path —
  // `filesystem.operations` flows through as a read/write/edit gate via
  // `buildCoreProviders`. `backend: "nexus"` is rejected at load time on
  // this host (see the check below) because the CLI's auto-allow
  // permission backend cannot enforce backend-aware approvals for
  // remote/bridge storage, which would silently grant a repo-local
  // manifest unreviewed access to data outside the workspace.
  let manifestFilesystemOps: readonly ("read" | "write" | "edit")[] | undefined;
  let manifestFilesystemBackend: FileSystemBackend | undefined;
  let manifestMiddleware: import("../manifest.js").ManifestMiddlewareEntry[] | undefined;
  if (flags.manifest !== undefined) {
    const manifestResult = await loadManifestConfig(flags.manifest);
    if (!manifestResult.ok) {
      process.stderr.write(`koi start: invalid manifest — ${manifestResult.error}\n`);
      return ExitCode.FAILURE;
    }
    manifestModelName = manifestResult.value.modelName;
    manifestInstructions = manifestResult.value.instructions;
    manifestStacks = manifestResult.value.stacks;
    manifestPlugins = manifestResult.value.plugins;
    manifestMiddleware =
      manifestResult.value.middleware !== undefined
        ? [...manifestResult.value.middleware]
        : undefined;

    // Fail fast on settings that `koi start` cannot honor, rather
    // than silently discarding them. A shared manifest that targets
    // both `koi tui` and `koi start` should omit these fields (or
    // split into host-specific manifests) — accepting valid syntax
    // and then silently overriding it is more user-hostile than a
    // clear error at launch.

    if (manifestResult.value.backgroundSubprocesses === true) {
      process.stderr.write(
        "koi start: manifest.backgroundSubprocesses: true is not supported on this host.\n" +
          "  The engine's default loop detector hard-fails legitimate task_output polling\n" +
          "  of long-running background subprocesses (3-in-8 threshold). Until the\n" +
          "  detector gains per-tool exemptions, koi start cannot enable bash_background\n" +
          "  without reintroducing the polling failure mode.\n" +
          "  Remove `backgroundSubprocesses: true` from the manifest to run under koi\n" +
          "  start, or use `koi tui` — the same manifest works there without modification\n" +
          "  once this field is removed.\n",
      );
      return ExitCode.FAILURE;
    }

    // #1777 two-gate trust boundary for nexus backends:
    //   Gate 1 — manifest must declare scope (root + mode in options)
    //   Gate 2 — operator must pass --allow-remote-fs to explicitly
    //             authorize remote storage access at the CLI level.
    // Both gates must pass; failing closed at gate 1 catches manifests
    // that omit scope accidentally, and failing closed at gate 2 ensures
    // the operator (not just the manifest author) has reviewed the risk.
    if (manifestResult.value.filesystem?.backend === "nexus") {
      const scope = manifestResult.value.filesystem.options;
      const root = typeof scope?.root === "string" ? scope.root : undefined;
      const mode = scope?.mode;

      // Gate 1: manifest must declare scope
      if (root === undefined || (mode !== "ro" && mode !== "rw")) {
        process.stderr.write(
          "koi start: nexus backends require 'filesystem.options.root' and 'filesystem.options.mode' " +
            "in the manifest.\n" +
            "Add filesystem.options.root and filesystem.options.mode to your manifest, or use 'koi tui'.\n",
        );
        return ExitCode.FAILURE;
      }

      // Gate 2: operator must opt in
      if (!flags.allowRemoteFs) {
        process.stderr.write(
          "koi start: nexus filesystem backends require --allow-remote-fs.\n" +
            "This flag confirms the operator (not the manifest) authorizes remote storage access.\n" +
            `Scope: ${root} (mode: ${mode})\n`,
        );
        return ExitCode.FAILURE;
      }
    }

    // OAuth-gated schemes require interactive auth UI (koi tui).
    // `koi start` cannot route `auth_required` notifications back to the
    // user because it has no channel-aware auth handler — accepting these
    // schemes and silently failing on first filesystem call would give a
    // confusing mid-session error. Reject deterministically here.
    if (manifestResult.value.filesystem?.options !== undefined) {
      const opts = manifestResult.value.filesystem.options as Record<string, unknown>;
      const uri = opts.mountUri;
      if (typeof uri === "string" && /^(gdrive|gmail|s3|dropbox):\/\//i.test(uri)) {
        process.stderr.write(
          `koi start: OAuth-gated mount '${uri.split("://")[0]}://' requires interactive authentication.\n` +
            "Use 'koi tui' for OAuth-gated mounts.\n",
        );
        return ExitCode.FAILURE;
      }
      // Local bridge transport (options.transport === "local") requires the
      // async resolver (subprocess lifecycle, auth notification wiring) which
      // koi start does not support. Reject explicitly rather than letting the
      // sync resolver fail with a confusing "invalid nexus config" error.
      if (opts.transport === "local") {
        process.stderr.write(
          "koi start: local-bridge transport (transport: local) requires 'koi tui'.\n" +
            "  The local bridge spawns a subprocess that needs async lifecycle management\n" +
            "  not available in the non-interactive koi start host.\n" +
            "  Use 'koi tui' for local-bridge nexus mounts, or switch to transport: http.\n",
        );
        return ExitCode.FAILURE;
      }
    }

    // Apply the `FileSystemConfig.operations` contract's `["read"]`
    // default at the host level so manifest-driven filesystems default
    // to read-only on the host-default local backend path.
    // `buildCoreProviders` honors `filesystemOperations` verbatim.
    //
    // NOTE: `filesystem.operations` gates ONLY the `fs_read`/`fs_write`/
    // `fs_edit` tools. The execution stack's `Bash` provider stays
    // wired, so a model in a read-only manifest posture can still
    // mutate the workspace via shell commands. `operations` is
    // therefore advisory for the fs_* surface, not a hard write
    // barrier. Manifest authors who need a true read-only posture
    // should also pass `stacks: [notebook, rules, skills, ...]` (omit
    // `execution`) to strip the bash provider entirely.
    if (manifestResult.value.filesystem !== undefined) {
      manifestFilesystemOps = manifestResult.value.filesystem.operations ?? (["read"] as const);
      // Resolve the manifest filesystem backend (local or nexus) so koi start
      // uses the correct backend, not the default local one. The sync path is
      // sufficient here — koi start rejects OAuth mounts above, and the async
      // path (local bridge subprocess) is only needed for OAuth-gated mounts.
      manifestFilesystemBackend = resolveFileSystem(manifestResult.value.filesystem, process.cwd());
    }

    if (manifestResult.value.stacks?.includes("spawn")) {
      process.stderr.write(
        'koi start: manifest.stacks including "spawn" is not supported on this host.\n' +
          "  Spawn enables coordinator workflows that poll task_output while waiting on\n" +
          "  sub-agents, which hard-fails under koi start's default loop detector. The\n" +
          "  spawn stack is automatically excluded from the koi start default stack set\n" +
          "  for this reason; an explicit stacks list that re-adds it would reintroduce\n" +
          "  the failure mode.\n" +
          '  Remove "spawn" from manifest.stacks to run under koi start, or use `koi tui`\n' +
          "  for coordinator workflows.\n",
      );
      return ExitCode.FAILURE;
    }
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

  // Generation counter for the transcript, incremented whenever loop mode
  // truncates the transcript back to its baseline between iterations. Each
  // stream() invocation captures the current generation at start time; its
  // final transcript.push() compares against the live generation and skips
  // the write if it has advanced. This fences off orphaned iteration
  // streams whose model call completes in the background AFTER the next
  // loop iteration has already started.
  // let: mutable — bumped on every loop reset
  let transcriptGeneration = 0;
  const incrementTranscriptGeneration = (): void => {
    transcriptGeneration += 1;
  };

  // let: justified — reassigned once on successful --resume
  let sid = sessionId(crypto.randomUUID());

  // Messages loaded from a resumed session; pushed into the runtime's
  // in-memory transcript AFTER the factory call returns (the factory
  // owns the transcript array and exposes it via `handle.transcript`).
  let resumedMessages: readonly InboundMessage[] = [];

  if (flags.resume !== undefined) {
    const resumeResult = await resumeSessionFromJsonl(flags.resume, jsonlTranscript, SESSIONS_DIR);
    if (!resumeResult.ok) {
      process.stderr.write(
        `koi start: cannot resume session "${flags.resume}" — ${resumeResult.error}\n`,
      );
      return ExitCode.FAILURE;
    }
    resumedMessages = resumeResult.value.messages;
    sid = resumeResult.value.sid;
    if (flags.verbose && resumeResult.value.issueCount > 0) {
      process.stderr.write(
        `koi start: resumed with ${resumeResult.value.issueCount} repair issue(s)\n`,
      );
    }
    // Render the loaded history to stdout so the user sees the prior
    // conversation before the next prompt. Filter rules live in
    // `@koi/core/message#filterResumedMessagesForDisplay` so CLI and TUI
    // stay in lockstep.
    const displayable = filterResumedMessagesForDisplay(resumedMessages);
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
  // 4. Runtime assembly via shared factory
  // ---------------------------------------------------------------------------
  //
  // `createKoiRuntime` is the same factory `koi tui` uses. `koi start`
  // differs only in the permission backend (auto-allow — the plain REPL
  // has no interactive approval UI), the hostId/engineId labels, and
  // the loop-mode generation fence. Everything else — MCP loading,
  // hook loading, plugin activation, middleware composition, provider
  // set, createKoi call — lives in the factory so a feature added
  // there lands in both hosts automatically.
  //
  // In loop mode (--until-pass), session-transcript persistence is
  // intentionally disabled. Every iteration would otherwise write a new
  // entry to the JSONL session log, so a later `koi start --resume <id>`
  // would replay all failed attempts as part of the user context.
  const isLoopMode = flags.mode.kind === "prompt" && flags.untilPass.length > 0;

  // OTel SDK bootstrap — must happen before createKoiRuntime so the global
  // TracerProvider is registered before middleware-otel calls trace.getTracer().
  const otelEnabled = process.env.KOI_OTEL_ENABLED === "true";
  const otelHandle = otelEnabled ? initOtelSdk("headless") : undefined;

  let runtimeHandle: Awaited<ReturnType<typeof createKoiRuntime>>;
  try {
    runtimeHandle = await createKoiRuntime({
      modelAdapter,
      modelName: model,
      approvalHandler: autoApproveHandler,
      cwd: process.cwd(),
      engineId: "koi-cli",
      hostId: "koi-cli",
      permissionBackend: createPatternPermissionBackend({
        rules: { allow: ["*"], deny: [], ask: [] },
      }),
      permissionsDescription: "koi start — auto-allow",
      // `koi start` runs without `bash_background` because main's
      // pre-refactor `koi start` never exposed that tool. The shared
      // execution stack wires it by default for TUI, so we explicitly
      // opt out here.
      //
      // `loopDetection` is left at the engine default (undefined →
      // detector enabled) because the auto-allow permission backend
      // makes the detector the only narrow guard against runaway
      // mutating calls before governance caps trip.
      //
      // The full `task_*` tool set stays wired regardless, but the
      // `spawn` stack is filtered out below — without sub-agents to
      // orchestrate, `task_output` polling has no reason to fire and
      // can't trip the detector's 3-in-8 threshold. This matches
      // main's pre-refactor `koi start` capability surface (no
      // Spawn, no bash_background, no coordinator workflows).
      backgroundSubprocesses: false,
      ...(manifestInstructions !== undefined ? { systemPrompt: manifestInstructions } : {}),
      // KOI_PLANNING_ENABLED=true opts into @koi/middleware-planning
      // (write_plan tool). Default off pending durable persistence
      // (#1842). See runtime-factory.ts for the trade-off.
      ...(process.env.KOI_PLANNING_ENABLED === "true" ? { planningEnabled: true } : {}),
      // When the user passes an explicit manifest.stacks, we honor
      // it verbatim (including re-enabling `spawn` if they really
      // want coordinator flows under `koi start`). When they don't,
      // we filter `spawn` out of the default set so the detector
      // stays compatible with the remaining tool surface.
      ...(manifestStacks !== undefined
        ? { stacks: manifestStacks }
        : { stacks: DEFAULT_STACKS_WITHOUT_SPAWN }),
      ...(manifestPlugins !== undefined ? { plugins: manifestPlugins } : {}),
      ...(manifestFilesystemOps !== undefined
        ? { filesystemOperations: manifestFilesystemOps }
        : {}),
      ...(manifestFilesystemBackend !== undefined ? { filesystem: manifestFilesystemBackend } : {}),
      // Zone B — manifest-declared middleware. Resolved inside the
      // factory; unknown names throw, core names are blocked by the
      // loader, and composed entries run INSIDE the security guard.
      //
      // `allowManifestFileSinks` gates the built-in audit entry
      // (which opens a file at resolution time). Controlled by the
      // KOI_ALLOW_MANIFEST_FILE_SINKS env var rather than the
      // manifest so repo content cannot flip it.
      ...(manifestMiddleware !== undefined ? { manifestMiddleware } : {}),
      ...(process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1"
        ? { allowManifestFileSinks: true }
        : {}),
      ...(isLoopMode ? {} : { session: { transcript: jsonlTranscript, sessionId: sid } }),
      getGeneration: () => transcriptGeneration,
      ...(otelEnabled ? { otel: true as const } : {}),
    });
  } catch (e: unknown) {
    // Ensure OTel provider is shut down even if runtime assembly fails.
    await otelHandle?.shutdown();
    throw e;
  }
  const runtime = runtimeHandle.runtime;
  const transcript = runtimeHandle.transcript;

  /**
   * Wrapper passed to `createCliHarness` so the harness's internal
   * `runtime.dispose()` call in its `finally` block is a no-op. The
   * real shutdown sequence (stack onShutdown → drain → dispose)
   * runs in `shutdownRuntime()` below, which is invoked AFTER the
   * harness returns. Without this wrapper, the harness would
   * dispose the runtime before the stack `onShutdown` hooks get a
   * chance to fire — MCP connections, the execution stack's
   * bgController, and other cleanup would run against an already-
   * disposed engine and either no-op silently or error.
   */
  const harnessRuntime: typeof runtime = {
    ...runtime,
    dispose: async () => {
      /* no-op: real dispose in shutdownRuntime() */
    },
  };

  // Shutdown failure flag — set by `shutdownRuntime()` when
  // teardown (stack onShutdown hooks, bg controller abort, or
  // `runtime.dispose()`) reports a failure. `run()` reads this
  // after each exit path's `finally` completes and returns
  // `ExitCode.FAILURE` when set, so automation sees a non-zero
  // exit when transcript flush, session-end hooks, or MCP
  // disposers fail even though the command body completed
  // successfully.
  // let: mutable — set from within shutdownRuntime on teardown failure
  let shutdownFailed = false;

  /**
   * Shared shutdown sequence — MUST run after the harness returns
   * and before any `process.exit()` path. Order matches the TUI
   * invariant:
   *
   *   1. Fire stack `onShutdown` hooks via `shutdownBackgroundTasks`
   *      (MCP disposers, execution stack's bgController abort for
   *      hosts that enabled background subprocesses).
   *   2. If any stack reported live work, wait out the SIGTERM→
   *      SIGKILL escalation window so subprocesses can't keep
   *      mutating the workspace past CLI exit.
   *   3. Dispose the runtime (engine teardown, session-end hooks
   *      including transcript flush).
   *
   * The harness's own `runtime.dispose()` is a no-op thanks to
   * `harnessRuntime` wrapping above, so this is the only place
   * `runtime.dispose()` actually runs.
   *
   * Called from `finally` blocks after the surrounding `catch`
   * has already run, so any exception escaping this helper would
   * bypass the command's normal error path and surface as an
   * unhandled rejection. Each step is wrapped in its own
   * try/catch so a wedged dispose timeout, a failing stack
   * onShutdown hook, or a broken MCP disposer surfaces as a
   * controlled stderr log AND flips `shutdownFailed` so `run()`
   * propagates the failure as `ExitCode.FAILURE`.
   */
  const shutdownRuntime = async (): Promise<void> => {
    try {
      const hadLiveWork = runtimeHandle.shutdownBackgroundTasks();
      if (hadLiveWork) {
        // Matches the execution stack's internal SUBPROCESS_DRAIN_MS
        // (3500ms) plus a 200ms safety margin.
        await new Promise<void>((resolve) => setTimeout(resolve, 3_700));
      }
    } catch (shutdownErr) {
      shutdownFailed = true;
      process.stderr.write(
        `koi: shutdownBackgroundTasks failed — ${
          shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr)
        }\n`,
      );
    }
    try {
      await runtime.dispose?.();
    } catch (disposeErr) {
      // `runtime.dispose()` can throw on settle timeout when a
      // tool is wedged in the active run, and its session-end
      // hooks run the transcript flush — a failure here means
      // the user-visible session may be incomplete on disk.
      // Flip `shutdownFailed` so the command returns a non-zero
      // exit code instead of reporting success after teardown
      // actually failed.
      shutdownFailed = true;
      process.stderr.write(
        `koi: runtime.dispose failed — ${
          disposeErr instanceof Error ? disposeErr.message : String(disposeErr)
        }\n`,
      );
    }
    // Flush OTel spans before process exit
    await otelHandle?.shutdown();
  };
  // Pre-populate the runtime's in-memory transcript with the resumed
  // messages so the model sees prior context on the first turn.
  if (resumedMessages.length > 0) {
    transcript.push(...resumedMessages);
  }

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
    // `harnessRuntime` has a no-op `dispose`; the real shutdown
    // sequence (stack onShutdown → drain → dispose) fires from
    // `shutdownRuntime()` in each exit path's `finally`. Passing
    // the raw `runtime` here would let the harness's internal
    // `finally` call `runtime.dispose()` before stack shutdown
    // hooks can run, leaking MCP / bg subprocesses.
    runtime: harnessRuntime,
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
          await shutdownRuntime();
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
            await shutdownRuntime();
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
        } finally {
          // Single-shot prompt mode also needs the shared shutdown
          // path — otherwise a model that launches `bash_background`
          // and then completes the turn leaves the subprocess
          // orphaned past CLI exit (the harness's own dispose only
          // calls `runtime.dispose`, not the stack onShutdown hooks).
          await shutdownRuntime();
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

    // Non-zero exit when shutdown/teardown reported a failure
    // (wedged dispose, failing MCP disposer, transcript flush
    // error). `shutdownRuntime()` logs the specific error to
    // stderr and sets this flag; automation sees a non-zero exit
    // code so it doesn't believe the run completed cleanly when
    // persistence or cleanup actually failed.
    if (shutdownFailed) {
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
