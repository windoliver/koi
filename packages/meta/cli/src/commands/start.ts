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
import { ndjsonSafeStringify } from "../headless/ndjson-safe-stringify.js";
// Static imports for the headless helpers so the bootstrap watchdog can
// arm before ANY await in run(). A hung module-resolution path on dynamic
// import would otherwise wedge the process before the timer even starts.
import {
  emitHeadlessSessionStart,
  emitPreRunTimeoutResult,
  HEADLESS_EXIT,
  runHeadless,
} from "../headless/run.js";
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
 * Headless approval handler.
 *
 * Every path that falls through the permission BACKEND and reaches the
 * APPROVAL HANDLER (Bash AST-elicit for `too-complex` commands like
 * `$VAR`, `$(...)`, `for` loops; MCP tools that explicitly request
 * approval) must resolve without prompting a human. The decision is
 * derived from `--allow-tool`:
 *
 *   - If the request's toolId is on the operator's whitelist, allow it.
 *     The whole point of `--allow-tool Bash` is that the operator has
 *     accepted responsibility for whatever shell commands the model
 *     issues; failing them via the elicit path would silently defeat the
 *     contract.
 *   - Otherwise, deny with a structured reason so the NDJSON result can
 *     surface PERMISSION_DENIED (see headless/run.ts's marker list).
 */
function createHeadlessApprovalHandler(allowTools: readonly string[]): ApprovalHandler {
  const allowed = new Set(allowTools);
  return async (request) => {
    if (allowed.has(request.toolId)) {
      return { kind: "always-allow", scope: "session" };
    }
    return {
      kind: "deny",
      reason: "headless mode: interactive approval is not available",
    };
  };
}

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
  // Trust-boundary gate: disable user-registered hooks
  // (~/.koi/hooks.json) in headless unless the operator opts in via
  // KOI_HEADLESS_ALLOW_HOOKS=1. Passed to createKoiRuntime as a
  // per-invocation config option (disableUserHooks) rather than via
  // process.env mutation, so concurrent runtimes in the same process
  // cannot interfere with each other's hook policy.
  const disableUserHooks = flags.headless && process.env.KOI_HEADLESS_ALLOW_HOOKS !== "1";

  // Headless mode frames EVERY failure as NDJSON so CI consumers always
  // see a parseable terminal `result` on stdout plus a structured exit
  // code from the 0-5 set — including the setup-time paths that come
  // before the main runHeadless() call (dry-run / log-format guards,
  // manifest/API/runtime assembly failures, etc.).
  //
  // Using a setup-sid that is also threaded into runHeadless later keeps
  // every event in the stream (session_start → ... → result) carrying
  // the same sessionId.
  const setupSid: string | undefined = flags.headless ? sessionId(crypto.randomUUID()) : undefined;
  let setupSessionEmitted = false;

  // Early SIGINT trap: headless consumers expect every termination to
  // produce a parseable NDJSON `result`. Without this, an operator
  // cancelling during bootstrap (slow manifest load, plugin/hook loader,
  // MCP setup) would see the shell's raw signal-exit with no result
  // event. Installed BEFORE any awaited work in run(). Removed by
  // createSigintHandler() later, which replaces it with the full runtime-
  // aware handler.
  let earlySigintInstalled = false;
  const earlySigintHandler = (): void => {
    if (setupSid === undefined) return;
    if (!setupSessionEmitted) {
      emitHeadlessSessionStart(setupSid, (s) => process.stdout.write(s));
      setupSessionEmitted = true;
    }
    process.stdout.write(
      `${ndjsonSafeStringify({
        kind: "result",
        sessionId: setupSid,
        ok: false,
        exitCode: 1,
        error: "cancelled during bootstrap",
      })}\n`,
    );
    process.stderr.write("koi start: cancelled during bootstrap\n");
    process.stdout.write("", () => {
      process.stderr.write("", () => {
        process.exit(1);
      });
    });
  };
  if (flags.headless) {
    process.on("SIGINT", earlySigintHandler);
    earlySigintInstalled = true;
  }
  const removeEarlySigint = (): void => {
    if (earlySigintInstalled) {
      process.removeListener("SIGINT", earlySigintHandler);
      earlySigintInstalled = false;
    }
  };

  // MCP + --max-duration-ms is retry-unsafe: MCP callTool() is non-
  // cancellable once dispatched (see archive/v1 notes and the MCP
  // contract), so a timer-triggered process.exit(4) can leave a remote
  // operation still running and potentially committed. Warn explicitly
  // at startup so CI authors don't wire retry logic under the false
  // assumption that exit 4 means "nothing happened".
  if (
    flags.headless &&
    flags.maxDurationMs !== undefined &&
    process.env.KOI_HEADLESS_ALLOW_MCP === "1"
  ) {
    process.stderr.write(
      "koi start --headless: WARNING: --max-duration-ms + KOI_HEADLESS_ALLOW_MCP is retry-unsafe. " +
        "MCP tool calls cannot be cancelled mid-flight; a timer-driven exit may leave remote side " +
        "effects committed. Treat exit 4 as indeterminate for idempotency purposes.\n",
    );
  }

  // ---------------------------------------------------------------------------
  // Headless timeout contract — known limitations
  // ---------------------------------------------------------------------------
  // The bootstrap and post-run deadline watchdogs call process.exit()
  // when they fire. This is a deliberate trade-off with two caveats that
  // in-process callers (embedders importing run() directly) need to know:
  //
  //   1. Bootstrap window: createKoiRuntime() performs async work —
  //      stack activation, plugin/hook loading, MCP connection setup —
  //      before returning a handle. If the bootstrap timer fires in that
  //      window, partially-opened resources (subprocesses, remote
  //      connections) are NOT torn down; there's no handle to dispose.
  //      Fixing this properly requires threading an AbortSignal through
  //      createKoiRuntime so it can unwind partial initialization.
  //      Filed as follow-up; exit 4 on bootstrap timeout is the current
  //      best-effort.
  //
  //   2. Hard process.exit: CLI callers are always about to exit
  //      anyway, so process.exit is safe. In-process embedders that
  //      import run() directly and pass --max-duration-ms should be
  //      aware that a timeout will terminate their host process, not
  //      just the command. Subprocess-based invocation is recommended
  //      for embedders that need control over timeout cancellation.
  //
  // Arm the process-wide deadline BEFORE any async bootstrap work (manifest
  // load, API/config resolution, createKoiRuntime — which loads plugins,
  // hooks, manifest middleware). The backstop inside the headless branch
  // only covers engine run + teardown; without this earlier arming, a
  // wedged bootstrap could hang indefinitely despite the advertised hard
  // timeout. This timer is transferred into the headless branch (cleared
  // there and replaced with a post-run variant) so we don't double-fire.
  //
  // SHUTDOWN_GRACE_MS matches the parser's reserved budget in args/start.ts.
  // It applies ONLY to the post-run teardown backstop (the run can overrun
  // by graceMs while disposers drain). Bootstrap itself must honor
  // --max-duration-ms exactly — there's no teardown during setup to justify
  // grace, and adding it would silently extend the advertised hard timeout.
  const SHUTDOWN_GRACE_MS = 10_000;

  // Absolute deadline anchored at process entry. Every phase (bootstrap,
  // engine run, teardown) computes its remaining budget from this single
  // reference point so --max-duration-ms is a true hard upper bound on
  // total wall-clock time, not a per-phase ceiling that resets after
  // bootstrap.
  const deadlineAt: number | undefined =
    flags.headless && flags.maxDurationMs !== undefined
      ? Date.now() + flags.maxDurationMs
      : undefined;
  const remainingBudget = (): number =>
    deadlineAt !== undefined ? Math.max(0, deadlineAt - Date.now()) : Number.POSITIVE_INFINITY;
  // Phase latch: set to true once bootstrap is complete and a later phase
  // (headless execute branch or a bail) owns the deadline. The bootstrap
  // timer callback checks this before emitting anything, so a callback
  // already dispatched by the Node timer queue before clearTimeout runs
  // cannot race with the main session's session_start/result pair.
  let bootstrapPhaseComplete = false;
  // Helpers are statically imported at module top (see top of file), so
  // the bootstrap watchdog can arm here BEFORE any awaited work. A hung
  // module-resolution path would otherwise wedge run() before the timer
  // could fire.
  let bootstrapDeadlineTimer: ReturnType<typeof setTimeout> | undefined =
    flags.headless && flags.maxDurationMs !== undefined
      ? setTimeout(() => {
          // Phase handoff race guard: the flag is checked here and the
          // callback body does NO awaits after, so a clearTimeout() +
          // bootstrapPhaseComplete=true sequence on the main thread
          // cannot lose a race to a queued callback.
          if (bootstrapPhaseComplete) return;
          if (setupSid === undefined) return;
          if (!setupSessionEmitted) {
            emitHeadlessSessionStart(setupSid, (s) => process.stdout.write(s));
            setupSessionEmitted = true;
          }
          process.stdout.write(
            `${ndjsonSafeStringify({
              kind: "result",
              sessionId: setupSid,
              ok: false,
              exitCode: 4,
              error: "bootstrap wedged past --max-duration-ms",
            })}\n`,
          );
          process.stderr.write("koi start: bootstrap wedged past --max-duration-ms\n");
          // NOTE: this branch fires while bootstrap is still wedged, so
          // runtimeHandle is unassigned and there is nothing to shut down
          // (no MCP connections, no hooks wired, no transcript open). An
          // orderly teardown is not achievable from here.
          //
          // Callback-chain flush: write("", cb) is queued AFTER our
          // already-buffered writes, so the callback fires once stdout has
          // drained. Same for stderr. Then exit. No awaits — keeps the
          // timer callback synchronous and race-free.
          process.stdout.write("", () => {
            process.stderr.write("", () => {
              process.exit(4);
            });
          });
        }, flags.maxDurationMs)
      : undefined;
  // Absolute-deadline accessor used by both the engine run and the
  // post-run backstop to keep total runtime under --max-duration-ms.
  // (deadlineAt + remainingBudget defined above.)
  const bail = async (message: string, headlessCode: 1 | 2 | 3 | 4 | 5 = 5): Promise<ExitCode> => {
    // Latch BEFORE clearing so any already-queued bootstrap timer callback
    // sees the phase-complete flag and no-ops. clearTimeout alone cannot
    // cancel a callback the timer queue has already dispatched.
    bootstrapPhaseComplete = true;
    if (bootstrapDeadlineTimer !== undefined) {
      clearTimeout(bootstrapDeadlineTimer);
      bootstrapDeadlineTimer = undefined;
    }
    // Remove the early SIGINT listener before emitting; bail() already
    // frames this as a deliberate failure and handles the NDJSON envelope,
    // so a stray Ctrl-C during bail shouldn't double-emit via the early
    // handler.
    removeEarlySigint();
    if (flags.headless && setupSid !== undefined) {
      if (!setupSessionEmitted) {
        emitHeadlessSessionStart(setupSid, (s) => process.stdout.write(s));
        setupSessionEmitted = true;
      }
      process.stdout.write(
        `${ndjsonSafeStringify({
          kind: "result",
          sessionId: setupSid,
          ok: false,
          exitCode: headlessCode,
          error: message,
        })}\n`,
      );
      process.stderr.write(`koi start: ${message}\n`);
      await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
      await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
      // Headless uses its own 0-5 exit-code set (issue #1648) which does
      // not fit the CLI's 0|1|2 ExitCode semantics. Hard-exit here so the
      // process surfaces the exact code without touching types.ts (which
      // is gated by the startup-latency measurement surface).
      process.exit(headlessCode);
    }
    process.stderr.write(`koi start: ${message}\n`);
    return ExitCode.FAILURE;
  };

  // Dry-run not yet implemented — fail closed so no live API calls are made.
  if (flags.dryRun) {
    return bail("--dry-run is not yet supported (tracking: #1264)");
  }

  // JSON log format not yet implemented — fail closed so operators don't silently
  // receive plain text when machine-parseable output was requested.
  if (flags.logFormat === "json") {
    return bail("--log-format json is not yet supported (tracking: #1264)");
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
      // Manifest error can include filesystem paths, user-provided values,
      // or schema diagnostics. Safe to classify but don't forward raw text
      // into the headless NDJSON envelope — full detail stays on the
      // operator's terminal (non-headless) where it's useful for debugging.
      const msg = flags.headless
        ? `invalid manifest (${manifestResult.error.length} chars redacted)`
        : `invalid manifest — ${manifestResult.error}`;
      return bail(msg);
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
      return bail(
        "manifest.backgroundSubprocesses: true is not supported on this host. " +
          "The engine's default loop detector hard-fails legitimate task_output polling of " +
          "long-running background subprocesses (3-in-8 threshold). Remove " +
          "`backgroundSubprocesses: true` from the manifest to run under koi start, or use " +
          "`koi tui`.",
      );
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
        return bail(
          "nexus backends require 'filesystem.options.root' and 'filesystem.options.mode' in the manifest. " +
            "Add filesystem.options.root and filesystem.options.mode to your manifest, or use 'koi tui'.",
        );
      }

      // Gate 2: operator must opt in.
      // The manifest `root` scope can encode tenant names, bucket prefixes,
      // or mount URIs. In headless mode that text is mirrored into NDJSON
      // stdout + stderr, so redact it there; interactive mode keeps the
      // full message to help the operator understand what was rejected.
      if (!flags.allowRemoteFs) {
        return bail(
          flags.headless
            ? `nexus filesystem backends require --allow-remote-fs (scope redacted, mode: ${mode})`
            : `nexus filesystem backends require --allow-remote-fs. This flag confirms the operator (not the manifest) authorizes remote storage access. Scope: ${root} (mode: ${mode})`,
        );
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
        return bail(
          `OAuth-gated mount '${uri.split("://")[0]}://' requires interactive authentication. Use 'koi tui' for OAuth-gated mounts.`,
        );
      }
      // Local bridge transport (options.transport === "local") requires the
      // async resolver (subprocess lifecycle, auth notification wiring) which
      // koi start does not support. Reject explicitly rather than letting the
      // sync resolver fail with a confusing "invalid nexus config" error.
      if (opts.transport === "local") {
        return bail(
          "local-bridge transport (transport: local) requires 'koi tui'. The local bridge spawns a subprocess that needs async lifecycle management not available in the non-interactive koi start host. Use 'koi tui' or switch to transport: http.",
        );
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
      // Headless fs trust-gate:
      //  - NEXUS backend: the two-gate path above already enforced manifest
      //    scope declaration + operator --allow-remote-fs opt-in. Honor it.
      //  - LOCAL backend with NO `options`: equivalent to the host default
      //    (workspace-rooted). Safe.
      //  - LOCAL backend WITH `options` (manifest root/mountUri): can
      //    redirect fs_* to arbitrary host paths OR scope them to a
      //    directory a workspace fallback would silently bypass. FAIL
      //    CLOSED — do not silently substitute the workspace backend.
      //    Require explicit opt-in via KOI_HEADLESS_ALLOW_MANIFEST_FS=1.
      //  - Interactive: always resolve as before.
      const fs = manifestResult.value.filesystem;
      const hasLocalOptions =
        fs.backend === "local" && fs.options !== undefined && Object.keys(fs.options).length > 0;
      const headlessOptIn = process.env.KOI_HEADLESS_ALLOW_MANIFEST_FS === "1";

      if (flags.headless && hasLocalOptions && !headlessOptIn) {
        return bail(
          "manifest.filesystem.options is not honored in --headless by default (scoped-local roots or mountUris can widen or redirect fs_* access). Remove manifest.filesystem.options, or set KOI_HEADLESS_ALLOW_MANIFEST_FS=1 to explicitly opt in.",
        );
      }

      manifestFilesystemOps = fs.operations ?? (["read"] as const);
      // Sync resolver is sufficient — OAuth mounts were rejected above,
      // and the async path (local bridge subprocess) is only needed for
      // OAuth-gated mounts.
      manifestFilesystemBackend = resolveFileSystem(fs, process.cwd());
    }

    if (manifestResult.value.stacks?.includes("spawn")) {
      return bail(
        'manifest.stacks including "spawn" is not supported on this host. Spawn enables coordinator workflows that poll task_output, which hard-fails under koi start\'s default loop detector. Remove "spawn" from manifest.stacks, or use `koi tui` for coordinator workflows.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 2. API configuration
  // ---------------------------------------------------------------------------

  const apiConfigResult = resolveApiConfig();
  if (!apiConfigResult.ok) {
    return bail(
      flags.headless
        ? `API config error (${apiConfigResult.error.length} chars redacted)`
        : apiConfigResult.error,
    );
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
      // resumeResult.error can carry file paths / user session IDs. Headless
      // emits a classifier-only message; flags.resume is additionally rejected
      // at parse time in headless mode, so this path is interactive-only in
      // practice — the non-headless branch keeps the full diagnostic.
      return bail(
        flags.headless
          ? `cannot resume session (${resumeResult.error.length} chars redacted)`
          : `cannot resume session "${flags.resume}" — ${resumeResult.error}`,
      );
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
      disableUserHooks,
      // Contain fs_* tools to the workspace in headless. With
      // allowExternalPaths=true (the default for interactive hosts),
      // a `--allow-tool fs_read` whitelist would still let the model
      // read /etc/passwd or ../../secrets.env on a CI runner — an
      // exfiltration path `--allow-tool` is not meant to open. Skipped
      // when the manifest supplies a filesystem backend explicitly.
      ...(flags.headless ? { workspaceOnlyFs: true } : {}),
      approvalHandler: flags.headless
        ? createHeadlessApprovalHandler(flags.allowTools)
        : autoApproveHandler,
      cwd: process.cwd(),
      engineId: "koi-cli",
      hostId: "koi-cli",
      permissionBackend: createPatternPermissionBackend({
        // Headless: allow only whitelisted tools; rely on the backend's
        // default-deny for everything else. The classifier evaluates deny
        // BEFORE allow, so `deny: ["*"]` would shadow the whitelist — instead,
        // an empty deny list plus an explicit allow list falls through to the
        // default-deny branch for non-whitelisted tools.
        rules: flags.headless
          ? { allow: [...flags.allowTools], deny: [], ask: [] }
          : { allow: ["*"], deny: [], ask: [] },
      }),
      permissionsDescription: flags.headless
        ? "koi start --headless — whitelist-based"
        : "koi start — auto-allow",
      // `koi start` is non-interactive and auto-allows every tool, so
      // a runaway active loop has no approval gate. Keep the wall-clock
      // cap tight (5 min) to match main's pre-refactor posture; the
      // interactive TUI uses the 30-min factory default because users
      // watch its output and can Ctrl-C a stuck turn. Operators can
      // still override via KOI_MAX_DURATION_MS.
      defaultMaxDurationMs: 300_000,
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
      // When the user passes an explicit manifest.stacks, we honor
      // it verbatim (including re-enabling `spawn` if they really
      // want coordinator flows under `koi start`). When they don't,
      // we filter `spawn` out of the default set so the detector
      // stays compatible with the remaining tool surface.
      // Headless strips the `mcp` stack: the preset unconditionally calls
      // loadUserMcpSetup(cwd, ...), which resolves repo-local `.mcp.json`
      // and opens live MCP connections before the --allow-tool whitelist
      // can mediate anything. Apply the filter to BOTH the default set AND
      // manifest-declared stacks — a repo manifest that says
      // `stacks: ["mcp", ...]` would otherwise re-open the bootstrap hole.
      // Opt-in via KOI_HEADLESS_ALLOW_MCP=1.
      ...(() => {
        const baseStacks = manifestStacks ?? DEFAULT_STACKS_WITHOUT_SPAWN;
        const headlessStripMcp = flags.headless && process.env.KOI_HEADLESS_ALLOW_MCP !== "1";
        return {
          stacks: headlessStripMcp ? baseStacks.filter((id) => id !== "mcp") : baseStacks,
        };
      })(),
      // Headless is a fail-closed CI/CD mode: manifest-declared plugins
      // are repo-controlled bootstrap-time execution surfaces that run
      // BEFORE the --allow-tool whitelist can mediate anything. The
      // factory's contract: `plugins: undefined` means AUTOLOAD EVERY
      // discovered plugin in ~/.koi/plugins, so omitting the field in
      // headless mode would silently re-enable them. Explicitly pass
      // `plugins: []` instead to force-load nothing. Opt-in via
      // KOI_HEADLESS_ALLOW_PLUGINS=1 routes back to manifest plugins
      // (non-autoload).
      ...(flags.headless
        ? process.env.KOI_HEADLESS_ALLOW_PLUGINS === "1" && manifestPlugins !== undefined
          ? { plugins: manifestPlugins }
          : { plugins: [] }
        : manifestPlugins !== undefined
          ? { plugins: manifestPlugins }
          : {}),
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
      // Same trust-boundary reasoning as manifestPlugins above: repo-
      // declared middleware runs inside the engine and can mutate every
      // model/tool call. Off in headless by default; opt-in via
      // KOI_HEADLESS_ALLOW_MIDDLEWARE=1.
      ...(manifestMiddleware !== undefined &&
      (!flags.headless || process.env.KOI_HEADLESS_ALLOW_MIDDLEWARE === "1")
        ? { manifestMiddleware }
        : {}),
      ...(process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1"
        ? { allowManifestFileSinks: true }
        : {}),
      // Headless CI runs write raw tool outputs (stderr fragments, URLs,
      // tokens, tenant data) into ~/.koi/sessions/<sid>.jsonl by default,
      // which undermines stdout redaction since shared CI runners
      // preserve that file on disk. Disable transcript persistence by
      // default in headless; opt-in via KOI_HEADLESS_PERSIST_TRANSCRIPT=1
      // for debugging.
      ...(isLoopMode || (flags.headless && process.env.KOI_HEADLESS_PERSIST_TRANSCRIPT !== "1")
        ? {}
        : { session: { transcript: jsonlTranscript, sessionId: sid } }),
      getGeneration: () => transcriptGeneration,
      ...(otelEnabled ? { otel: true as const } : {}),
    });
  } catch (e: unknown) {
    // Ensure OTel provider is shut down even if runtime assembly fails.
    await otelHandle?.shutdown();
    // In headless mode, route runtime-assembly throws through the same
    // NDJSON envelope as every other setup failure, so CI consumers see
    // a parseable `result` rather than an uncaught exception. Throws are
    // plausible here: stack/plugin/middleware resolution, manifest
    // middleware file-sink gating, etc.
    if (flags.headless) {
      const raw = e instanceof Error ? e.message : String(e);
      // Factory-time exceptions can carry module-resolution paths, manifest
      // middleware diagnostics, hook loader messages, or other repo-local
      // text. Classify-only in headless NDJSON; full detail goes to stderr
      // via the normal throw path only in non-headless mode.
      return bail(`runtime assembly failed (${raw.length} chars redacted)`);
    }
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
      const raw = shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr);
      // Redact teardown text in headless mode: shutdownBackgroundTasks can
      // fail inside tool/provider cleanup paths whose exceptions carry
      // transport URIs, tokens, or other sensitive text. CI stderr is
      // captured alongside stdout, so the headless redaction contract
      // covers this path too.
      process.stderr.write(
        flags.headless
          ? `koi: shutdownBackgroundTasks failed (${raw.length} chars redacted)\n`
          : `koi: shutdownBackgroundTasks failed — ${raw}\n`,
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
      const raw = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
      // Same redaction policy as shutdownBackgroundTasks above: dispose
      // errors frequently wrap tool/provider/session-end-hook exception
      // text.
      process.stderr.write(
        flags.headless
          ? `koi: runtime.dispose failed (${raw.length} chars redacted)\n`
          : `koi: runtime.dispose failed — ${raw}\n`,
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
  // Runtime is assembled — hand off SIGINT from the early bootstrap
  // handler to the full runtime-aware handler below. Remove the early
  // handler so both don't fire on the same signal.
  removeEarlySigint();
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

  if (flags.headless) {
    if (flags.mode.kind !== "prompt") {
      throw new Error("invariant: --headless requires --prompt (validated in parseStartFlags)");
    }
    // runHeadless, HEADLESS_EXIT, emitPreRunTimeoutResult, and
    // emitHeadlessSessionStart are statically imported at module top so
    // the bootstrap watchdog can arm before any await in run().
    // Bootstrap has completed — hand off the deadline from the bootstrap
    // watchdog to the post-run backstop below. Latch FIRST, then clear, so
    // any bootstrap callback already on the timer queue sees the flag and
    // no-ops instead of racing the main session's event stream.
    bootstrapPhaseComplete = true;
    if (bootstrapDeadlineTimer !== undefined) {
      clearTimeout(bootstrapDeadlineTimer);
      bootstrapDeadlineTimer = undefined;
    }
    // Own the single session_start emission here so the deadline backstop
    // can fall back to emitPreRunTimeoutResult without duplicating the
    // session header if it fires after runHeadless has started.
    emitHeadlessSessionStart(sid, (s) => process.stdout.write(s));
    // Backstop timer: if --max-duration-ms is set, enforce it as a real
    // process deadline. runHeadless itself honors the deadline for the engine
    // run, but shutdownRuntime() may spend several seconds draining
    // background work (#shutdown). The help text says "Hard timeout", so cap
    // the whole process including teardown: after (maxDurationMs + grace),
    // force-exit with TIMEOUT regardless of where we are.
    //
    // Keep the grace value in sync with SHUTDOWN_GRACE_MS in args/start.ts —
    // the parser reserves this budget so maxDurationMs + graceMs cannot
    // overflow Node's setTimeout.
    const shutdownGraceMs = 10_000;
    // Phase latch for the post-run deadline timer. clearTimeout cannot
    // cancel a callback already dispatched by Node's timer queue, so even
    // if the main thread successfully finishes shutdown and clears the
    // timer, a queued callback could fire and spuriously exit the process
    // with code 4. Check this flag first.
    let postRunPhaseComplete = false;
    // The backstop may fire before runHeadless has returned (engine wedged)
    // OR during shutdownRuntime() (teardown wedged). In the latter case we
    // have `emitResult` and can still produce a terminal NDJSON line; in the
    // former we fall back to a stderr diagnostic only. `onDeadlineExceeded`
    // is replaced once emitResult becomes available.
    //
    // let: reassigned after runHeadless returns so the timer closure picks up
    // the NDJSON-aware finalizer instead of the diagnostic-only default.
    let onDeadlineExceeded = (): void => {
      if (postRunPhaseComplete) return;
      process.stderr.write("koi headless: runtime wedged past --max-duration-ms; force-exiting\n");
      // Even though runHeadless hasn't returned, emit a minimal
      // session_start + terminal result so consumers get a parseable NDJSON
      // stream instead of a truncated one. This is the documented hard-
      // timeout contract.
      emitPreRunTimeoutResult(
        sid,
        (s) => process.stdout.write(s),
        "runtime wedged past --max-duration-ms",
      );
      process.stdout.write("", () => process.exit(HEADLESS_EXIT.TIMEOUT));
    };
    // NOT unref'd: the backstop must keep the event loop alive until it
    // fires, otherwise a wedged run with no other active handles could
    // terminate naturally and skip the forced timeout exit. The timer is
    // cleared on every normal exit path below.
    // Compute the REMAINING budget at this point (bootstrap may have
    // consumed some of the original maxDurationMs). The post-run backstop
    // + the engine's own deadline both use the remainder, so total
    // wall-clock stays under flags.maxDurationMs.
    const remainingForRunAndShutdown = remainingBudget();
    // If bootstrap already exhausted the budget, emit the timeout result
    // and exit — do not start the engine.
    if (flags.maxDurationMs !== undefined && remainingForRunAndShutdown === 0) {
      emitPreRunTimeoutResult(
        sid,
        (s) => process.stdout.write(s),
        "bootstrap exhausted --max-duration-ms before the engine could start",
      );
      // Route through shutdownRuntime even on timeout so MCP disposers,
      // plugin/stack onShutdown hooks, transcript flushes, and OTel span
      // drain all get at least a best-effort attempt. Swallow any
      // teardown error (signalled via shutdownFailed); the timeout result
      // already shipped.
      try {
        await shutdownRuntime();
      } catch {
        /* best-effort teardown; the terminal result already shipped */
      }
      await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
      process.exit(HEADLESS_EXIT.TIMEOUT);
    }
    const processDeadlineTimer =
      flags.maxDurationMs !== undefined
        ? setTimeout(() => onDeadlineExceeded(), remainingForRunAndShutdown + shutdownGraceMs)
        : undefined;
    // runHeadless does not throw — it converts all errors into a typed
    // exit code and an `emitResult` callback. We keep `emitResult` in outer
    // scope so that a later teardown throw can still emit a terminal NDJSON
    // line that matches the real process exit code.
    const { exitCode: headlessCode, emitResult } = await runHeadless({
      sessionId: sid,
      prompt: flags.mode.text,
      // Remaining budget only. Passing flags.maxDurationMs unchanged would
      // give the engine a fresh full-duration clock even though bootstrap
      // already consumed some of it.
      maxDurationMs: flags.maxDurationMs !== undefined ? remainingForRunAndShutdown : undefined,
      writeStdout: (s) => process.stdout.write(s),
      writeStderr: (s) => process.stderr.write(s),
      runtime,
      externalSignal: controller.signal,
    });
    // Upgrade the deadline finalizer now that we can emit a terminal result.
    onDeadlineExceeded = (): void => {
      if (postRunPhaseComplete) return;
      process.stderr.write(
        "koi headless: shutdown wedged past --max-duration-ms + grace; force-exiting\n",
      );
      emitResult({
        exitCode: HEADLESS_EXIT.TIMEOUT,
        error: "shutdown exceeded max-duration-ms + grace",
      });
      // Best-effort flush before hard exit.
      process.stdout.write("", () => process.exit(HEADLESS_EXIT.TIMEOUT));
    };
    let finalCode: number = headlessCode;
    try {
      await shutdownRuntime();
      // Latch BEFORE clearing the timer so a callback already on the
      // Node timer queue sees postRunPhaseComplete=true and no-ops
      // instead of racing the normal-exit path with a spurious exit 4.
      postRunPhaseComplete = true;
      if (processDeadlineTimer !== undefined) clearTimeout(processDeadlineTimer);
      // Any teardown failure is machine-visible as INTERNAL, regardless of
      // the run's own exit code. Preserving, e.g., PERMISSION_DENIED when
      // the session transcript was not flushed would hide exactly the
      // failure mode CI retry/recovery logic needs to detect. The original
      // code is preserved in the NDJSON result's error string for
      // diagnostics.
      if (shutdownFailed) {
        finalCode = HEADLESS_EXIT.INTERNAL;
        emitResult({
          exitCode: HEADLESS_EXIT.INTERNAL,
          error: `teardown failure (run exited ${headlessCode}); see stderr for disposer / transcript errors`,
        });
      } else {
        emitResult();
      }
    } catch (e: unknown) {
      postRunPhaseComplete = true;
      if (processDeadlineTimer !== undefined) clearTimeout(processDeadlineTimer);
      finalCode = HEADLESS_EXIT.INTERNAL;
      const raw = e instanceof Error ? e.message : String(e);
      // Redaction: shutdown errors can carry disposer / transport URIs /
      // transcript flush paths / session-end hook exception text. CI
      // captures stderr alongside stdout, so emit classification-only on
      // both streams in headless mode.
      process.stderr.write(`koi headless: shutdown failed (${raw.length} chars redacted)\n`);
      emitResult({
        exitCode: HEADLESS_EXIT.INTERNAL,
        error: `shutdown failed (${raw.length} chars redacted)`,
      });
    }
    // Flush stdout/stderr before returning so the final NDJSON `result`
    // line (and any teardown diagnostics on stderr) isn't lost when the
    // parent process closes fast. bin.ts calls process.exit with this
    // code, so the stream drains before the process dies.
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
    // Headless uses its own 0-5 exit-code set (issue #1648) which does
    // not fit the CLI's 0|1|2 ExitCode semantics. Hard-exit to surface
    // the exact code. This trips the in-process embedder case (already
    // documented as a known limitation in the help text); keeping
    // types.ts untouched is a hard requirement of the startup-latency
    // gate.
    process.exit(finalCode);
  }

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
