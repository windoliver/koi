/**
 * Shared runtime-wiring helpers for `koi start` and `koi tui`.
 *
 * The two commands have independent runtime-assembly flows (different
 * tool stacks, different middleware ordering, different permission
 * defaults) but a handful of L2 subsystems are wired identically on
 * both sides. This module consolidates those pieces so neither command
 * drifts from the other and so the merging logic is tested in one place.
 *
 * Extracted here:
 *   - User MCP setup   (.mcp.json → resolver → provider [+ skills bridge])
 *   - Plugin MCP setup (activated plugins' mcpServers → resolver → provider)
 *   - User hook loading (~/.koi/hooks.json → tier-tagged RegisteredHook[])
 *   - User + plugin hook merging (tier-tagged, deterministic order)
 *   - Session resume (JSONL transcript → resumed messages + repair issues)
 *
 * Intentionally NOT extracted: bash tool wiring (TUI uses
 * createBashToolWithHooks + elicit + trackCwd; `koi start` uses the
 * simpler createBashTool), permission backend construction (auto-allow
 * vs tiered rules), filesystem tools, and middleware composition order
 * — those are load-bearing differences between the two commands and
 * belong in the command files themselves.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ComponentProvider,
  HookConfig,
  InboundMessage,
  KoiMiddleware,
  SessionId,
  SessionTranscript,
  Tool,
} from "@koi/core";
import {
  createSingleToolProvider,
  DEFAULT_UNSANDBOXED_POLICY,
  sessionId,
  toolToken,
} from "@koi/core";
import { createSystemPromptMiddleware } from "@koi/engine";
import { createLocalFileSystem } from "@koi/fs-local";
import type { CreateHookMiddlewareOptions, RegisteredHook } from "@koi/hooks";
import {
  createHookMiddleware,
  createRegisteredHooks,
  loadRegisteredHooksPerEntry,
} from "@koi/hooks";
import type { McpResolver, McpServerConfig } from "@koi/mcp";
import { createMcpComponentProvider, createMcpResolver, loadMcpJsonFile } from "@koi/mcp";
import type { SkillsMcpBridge } from "@koi/runtime";
import { createSkillsMcpBridge } from "@koi/runtime";
import { createSessionTranscriptMiddleware, resumeForSession } from "@koi/session";
import type { SkillsRuntime } from "@koi/skills-runtime";
import {
  createBuiltinSearchProvider,
  createFsEditTool,
  createFsReadTool,
  createFsWriteTool,
} from "@koi/tools-builtin";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { createOAuthAwareMcpConnection } from "./mcp-connection-factory.js";

/** Common shape for an assembled MCP setup — user config or plugin-provided. */
export interface McpSetup {
  readonly resolver: McpResolver;
  readonly provider: ComponentProvider;
  /** Non-undefined only when a SkillsRuntime was supplied at construction. */
  readonly bridge: SkillsMcpBridge | undefined;
  /** Disposes the bridge (if any) and the underlying resolver. Idempotent. */
  readonly dispose: () => void;
}

/** Absolute path of `~/.koi/hooks.json` — the single user-tier hook source. */
export const USER_HOOKS_CONFIG_PATH: string = join(homedir(), ".koi", "hooks.json");

/**
 * Resolve the user hooks config path lazily. `USER_HOOKS_CONFIG_PATH` is
 * captured at module load, but tests need to redirect `$HOME` per-test and
 * Bun's `os.homedir()` does not re-read `process.env.HOME` between calls —
 * it returns a snapshot taken at process startup. Consulting `HOME` first
 * keeps test overrides working while preserving `homedir()` as the POSIX
 * fallback for environments where `HOME` is unset.
 */
function resolveUserHooksConfigPath(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".koi", "hooks.json");
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

/**
 * Load `.mcp.json` from the given cwd and assemble an McpSetup.
 *
 * Returns undefined when the file is absent, unreadable, or declares no
 * servers — matching the prior behavior of both call sites (silent skip).
 * When a SkillsRuntime is provided, also wires a best-effort SkillsMcpBridge
 * so MCP tools become discoverable as skills; a failing bridge.sync() is
 * demoted to "no bridge" rather than a fatal error, again matching the
 * prior TUI behavior.
 */
export async function loadUserMcpSetup(
  cwd: string,
  skillsRuntime: SkillsRuntime | undefined,
): Promise<McpSetup | undefined> {
  const mcpConfigPath = join(cwd, ".mcp.json");
  const result = await loadMcpJsonFile(mcpConfigPath);
  if (!result.ok) return undefined;
  if (result.value.servers.length === 0) return undefined;

  const connections = result.value.servers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  const provider = createMcpComponentProvider({ resolver });

  let bridge: SkillsMcpBridge | undefined;
  if (skillsRuntime !== undefined) {
    bridge = createSkillsMcpBridge({ resolver, runtime: skillsRuntime });
    try {
      await bridge.sync();
    } catch {
      // Non-fatal — MCP tools just won't appear as skills for this session.
      bridge = undefined;
    }
  }

  return {
    resolver,
    provider,
    bridge,
    dispose: () => {
      bridge?.dispose();
      resolver.dispose();
    },
  };
}

/**
 * Assemble an McpSetup from the McpServerConfig list provided by activated
 * plugins. Returns undefined when no plugin declared any MCP servers. Plugin
 * setups never carry a SkillsRuntime bridge because plugins register their
 * skills through the separate SkillsRuntime.registerExternal pipeline.
 */
export function buildPluginMcpSetup(
  pluginMcpServers: readonly McpServerConfig[],
): McpSetup | undefined {
  if (pluginMcpServers.length === 0) return undefined;
  const connections = pluginMcpServers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  const provider = createMcpComponentProvider({ resolver });
  return {
    resolver,
    provider,
    bridge: undefined,
    dispose: () => {
      resolver.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Hook loading + merging
// ---------------------------------------------------------------------------

/**
 * Load user-tier hooks from `~/.koi/hooks.json` as tier-tagged
 * `RegisteredHook`s.
 *
 * Loader semantics:
 * - File absent → silent empty result (hooks.json is optional).
 * - File present but unreadable / not JSON → **fatal**. Because the file's
 *   contents are unknown, we cannot tell whether the operator had declared
 *   any `failClosed:true` hooks in it; silently treating corruption as
 *   "no hooks configured" is the exact class of silent policy bypass this
 *   function exists to close. `onLoadError` is called with the diagnostic
 *   and then the function throws to abort startup.
 * - File present and parseable → each entry is validated independently via
 *   `loadRegisteredHooksPerEntry`. Invalid entries are reported through
 *   `onLoadError` (one call per error) and skipped; valid peers still load.
 *   This replaces the prior all-or-nothing behaviour where a single bad
 *   entry (e.g. an http hook lacking `KOI_DEV=1`) would silently drop every
 *   hook in the file (see issue #1781).
 *
 * Fail-closed opt-in: if any invalid entry has `failClosed: true` in the raw
 * JSON, the operator has explicitly declared that hook load-critical — this
 * function emits the normal per-entry diagnostics via `onLoadError` AND then
 * throws an Error so the caller aborts startup rather than running with a
 * reduced policy. Non-fail-closed invalid entries still partial-load (#1781).
 * Callers that don't want startup to abort should wrap the call in try/catch.
 *
 * When `filterAgentHooks` is true, any `kind: "agent"` hooks are removed
 * (and their names reported via the optional callback) so the caller can
 * warn the operator. Agent hooks require a spawnFn that the TUI does not
 * provide — the same filter applied before this helper existed.
 */
export async function loadUserRegisteredHooks(options: {
  readonly filterAgentHooks: boolean;
  readonly onAgentHooksFiltered?: (hookNames: readonly string[]) => void;
  readonly onLoadError?: (message: string) => void;
}): Promise<readonly RegisteredHook[]> {
  const path = resolveUserHooksConfigPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (e) {
    // File exists but cannot be read or parsed. We have no way to know
    // whether it declared any failClosed:true hooks, so fail closed rather
    // than silently proceed with an empty hook set (review round 2 finding).
    const detail = e instanceof Error ? e.message : String(e);
    const msg = `Could not read ${path}: ${detail}`;
    options.onLoadError?.(msg);
    throw new Error(`Refusing to start: ${msg}. Fix or remove the file before retrying.`);
  }

  const loaded = loadRegisteredHooksPerEntry(raw, "user");
  if (options.onLoadError !== undefined) {
    for (const err of loaded.errors) {
      const where =
        err.index < 0
          ? "hooks.json"
          : err.name !== undefined
            ? `hooks.json entry ${err.index} ("${err.name}")`
            : `hooks.json entry ${err.index}`;
      options.onLoadError(`${where}: ${err.message}`);
    }
    for (const w of loaded.warnings) {
      options.onLoadError(`hooks.json: ${w}`);
    }
  }

  // Structural root errors (non-array, etc.) are fatal: we cannot inspect
  // individual entries to see whether any were marked failClosed:true, and
  // an object-shaped root that contained a failClosed hook would otherwise
  // silently start the TUI with zero user hooks (review round 3 finding).
  // Same reasoning as the parse-failure branch above — "we don't understand
  // the file, so we cannot pretend nothing was configured."
  const structuralErrors = loaded.errors.filter((e) => e.index < 0);
  if (structuralErrors.length > 0) {
    throw new Error(
      `Refusing to start: ${path} is structurally invalid — ${structuralErrors
        .map((e) => e.message)
        .join("; ")}. Fix or remove the file before retrying.`,
    );
  }

  // Fail-closed opt-in (respects the operator's declared intent, addresses
  // the architectural concern that partial loading weakens enforcement):
  // if any invalid entry was marked `failClosed: true`, abort startup rather
  // than run with a reduced policy.
  const failClosedErrors = loaded.errors.filter((e) => e.failClosed === true);
  if (failClosedErrors.length > 0) {
    const labels = failClosedErrors
      .map((e) => (e.name !== undefined ? `"${e.name}"` : `entry ${e.index}`))
      .join(", ");
    throw new Error(
      `Refusing to start: ${failClosedErrors.length} hook(s) marked failClosed:true failed to load (${labels}). Fix ${path} or remove failClosed from the affected entries.`,
    );
  }

  if (!options.filterAgentHooks) return loaded.hooks;
  const agentHooks = loaded.hooks.filter((rh) => rh.hook.kind === "agent");
  if (agentHooks.length > 0 && options.onAgentHooksFiltered !== undefined) {
    options.onAgentHooksFiltered(agentHooks.map((rh) => rh.hook.name));
  }
  return loaded.hooks.filter((rh) => rh.hook.kind !== "agent");
}

/**
 * Merge already-loaded user-tier hooks with plugin-provided `HookConfig`s
 * (tier-tagged as "session"), returning a single deterministic list in
 * user-then-plugin order. When `filterAgentHooks` is true, `kind: "agent"`
 * plugin hooks are silently dropped to mirror the user-hook filter applied
 * by `loadUserRegisteredHooks`.
 */
export function mergeUserAndPluginHooks(
  userHooks: readonly RegisteredHook[],
  pluginHookConfigs: readonly HookConfig[],
  options: { readonly filterAgentHooks: boolean },
): readonly RegisteredHook[] {
  const filteredPluginConfigs = options.filterAgentHooks
    ? pluginHookConfigs.filter((h) => h.kind !== "agent")
    : pluginHookConfigs;
  const pluginRegistered = createRegisteredHooks(filteredPluginConfigs, "session");
  return [...userHooks, ...pluginRegistered];
}

// ---------------------------------------------------------------------------
// Session resume
// ---------------------------------------------------------------------------

/** Successful resume payload — messages to rehydrate + repair-issue count. */
export interface ResumedSession {
  /** Branded id of the resumed session (same as the rawId argument, branded). */
  readonly sid: SessionId;
  /** Conversation history as it was when the session was last persisted. */
  readonly messages: readonly InboundMessage[];
  /**
   * Number of repair issues found while replaying the JSONL. Non-zero
   * means the transcript had corrupt or partial entries that the resume
   * pipeline recovered from; callers may want to surface this to the
   * operator (stderr for CLI, a system message for TUI).
   */
  readonly issueCount: number;
}

/**
 * Load a JSONL session transcript and return the rehydrated messages.
 *
 * This is the shared resume entrypoint for `koi start --resume` and
 * `koi tui --resume`. The helper branded-wraps the raw session id,
 * calls `@koi/session/resumeForSession`, and normalizes the result
 * into a plain `Result<ResumedSession, string>` so each command can
 * present the failure in its own UI idiom (stderr for start, a
 * rendered error banner for tui). The helper intentionally performs
 * no I/O-side logging — callers own the user-facing output.
 */
export async function resumeSessionFromJsonl(
  rawId: string,
  jsonlTranscript: SessionTranscript,
  sessionsDir: string,
): Promise<
  | { readonly ok: true; readonly value: ResumedSession }
  | { readonly ok: false; readonly error: string }
> {
  // Resume ids can arrive in two shapes:
  //   1. A plain branded id minted by this branch (e.g.
  //      `86cfcc00-...`). The file lives at
  //      `<sessionsDir>/86cfcc00-....jsonl` and the encoding is
  //      a no-op.
  //   2. A legacy composite id from an older engine or from
  //      `koi sessions list`, which exposes the raw basename
  //      without decoding (`agent%3A<pid>%3A<uuid>`). The file
  //      lives at `<sessionsDir>/agent%3A...%3A....jsonl`, but
  //      blindly passing that basename through
  //      `encodeURIComponent` produces `agent%253A...` and
  //      misses the file. Try raw first, then fall back to the
  //      decoded form so users can copy-paste either what
  //      `koi sessions list` prints OR what the new post-quit
  //      hint prints.
  const candidates: string[] = [rawId];
  try {
    const decoded = decodeURIComponent(rawId);
    if (decoded !== rawId) candidates.push(decoded);
  } catch {
    // Malformed percent-encoding — fall through with just the raw id.
  }

  // Fail closed for nonexistent session files. The JSONL store
  // returns `{ ok: true, entries: [] }` for a missing file so
  // that appends-to-new-sessions can work, which means a typoed
  // or stale `--resume <id>` would otherwise succeed silently
  // and fork into a new blank transcript under the mistyped id.
  // Valid-but-empty sessions (a file that exists but contains
  // zero turns because of a prior `/clear` truncate) must still
  // resume successfully, so we distinguish the two states by
  // probing filesystem existence directly — Bun.file exposes
  // an explicit `exists()` that the SessionTranscript interface
  // does not.
  // let: justified — assigned once a candidate's file is found
  let foundCanonical: string | null = null;
  // let: justified — captured for the error path below
  let lastProbedPath = "";
  for (const candidate of candidates) {
    const candidatePath = `${sessionsDir}/${encodeURIComponent(candidate)}.jsonl`;
    lastProbedPath = candidatePath;
    if (await Bun.file(candidatePath).exists()) {
      foundCanonical = candidate;
      break;
    }
  }
  if (foundCanonical === null) {
    return {
      ok: false,
      error:
        `no transcript found for session id "${rawId}" at ${lastProbedPath}. ` +
        "Check the id (the post-quit hint prints the exact command) or " +
        "use `koi sessions list` to see saved sessions.",
    };
  }

  const sid = sessionId(foundCanonical);
  const result = await resumeForSession(sid, jsonlTranscript);
  if (!result.ok) {
    return { ok: false, error: result.error.message };
  }
  return {
    ok: true,
    value: {
      sid,
      messages: result.value.messages,
      issueCount: result.value.issues.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared middleware factory wrappers
//
// These are the middleware types that both `koi start` and `koi tui` wire
// with IDENTICAL factory calls — only the position in the per-host stack
// differs. Each wrapper returns `undefined` when the input opts out so
// call sites can conditionally splice the result into their middleware
// array with a single `...(x !== undefined ? [x] : [])` spread.
//
// Rule: any middleware added here should be opt-in via a config field so
// a new host (CI runner, daemon, etc.) can wire only the pieces it wants.
// Host-specific middleware (event-trace, exfiltration-guard, etc.) stays
// in the host file — these wrappers are only for the overlap.
// ---------------------------------------------------------------------------

/**
 * Build the optional session-transcript middleware. Returns `undefined`
 * when no session is configured (e.g. `koi start --until-pass` loop mode
 * disables persistence because intermediate iterations are not resumable).
 */
export function buildSessionTranscriptMw(
  session: { readonly transcript: SessionTranscript; readonly sessionId: SessionId } | undefined,
): KoiMiddleware | undefined {
  if (session === undefined) return undefined;
  return createSessionTranscriptMiddleware({
    transcript: session.transcript,
    sessionId: session.sessionId,
  });
}

/**
 * Build the optional system-prompt middleware. Returns `undefined` when
 * the caller has no system prompt to inject (rare — both hosts currently
 * always supply one, but the config field is optional and this preserves
 * that shape).
 */
export function buildSystemPromptMw(prompt: string | undefined): KoiMiddleware | undefined {
  if (prompt === undefined || prompt.length === 0) return undefined;
  return createSystemPromptMiddleware(prompt);
}

/**
 * Build a hook middleware unconditionally from an already-merged
 * `RegisteredHook[]` plus host-specific extras. Used by hosts that need
 * the middleware slot populated even when no user hooks are registered
 * (e.g. the TUI's hook-observer tap, which still records trace spans).
 *
 * `extras` forwards host-specific options: the TUI passes `promptCallFn`
 * (for prompt-hook verification against its model adapter) and
 * `onExecuted` (for the hook-observer ATIF tap); `koi start` passes
 * neither. Any new option added to `CreateHookMiddlewareOptions` lands
 * here automatically.
 */
export function buildHookMw(
  hooks: readonly RegisteredHook[],
  extras?: Omit<CreateHookMiddlewareOptions, "hooks"> | undefined,
): KoiMiddleware {
  return createHookMiddleware({ hooks, ...(extras ?? {}) });
}

/**
 * Like `buildHookMw` but returns `undefined` when there are no hooks and
 * no `onExecuted` tap to record, so the caller can skip the middleware
 * slot entirely for a cleaner trace stack. `koi start` uses this variant
 * because it has no hook-observer tap to preserve.
 */
export function buildHookMwOrUndefined(
  hooks: readonly RegisteredHook[],
  extras?: Omit<CreateHookMiddlewareOptions, "hooks"> | undefined,
): KoiMiddleware | undefined {
  if (hooks.length === 0 && extras?.onExecuted === undefined) return undefined;
  return buildHookMw(hooks, extras);
}

// ---------------------------------------------------------------------------
// Shared core KoiMiddleware slots
//
// Both hosts need permissions + hook + system-prompt + session-transcript
// middleware, but they splice them into different positions in their
// full middleware array:
//   CLI:  [sessionTranscript, perm, hook, systemPrompt]         (perm → hook)
//   TUI:  [eventTrace, hook, hookObserver, rules, perm, exfil,  (hook → perm)
//          extract, semanticRetry, ..., systemPrompt, sessionTranscript]
//
// Rather than emit one ordered array that fits neither, this helper
// returns a tagged record of the slots. Each host composes the slots
// into its own middleware order. Adding a new core middleware type =
// one new slot on this record + one splice point in each host (still
// two edits, but the factory construction lives in one file).
// ---------------------------------------------------------------------------

export interface CoreMiddlewareConfig {
  /**
   * Permissions middleware — callers construct it with their own
   * PermissionBackend (CLI: auto-allow pattern backend; TUI: default
   * mode with tiered allow rules) because the backend shape drifts
   * too far to share.
   */
  readonly permissionsMiddleware: KoiMiddleware;
  /** Already-merged hook list (user + plugin, tier-tagged). */
  readonly hooks: readonly RegisteredHook[];
  /** Host-specific extras for `createHookMiddleware` (promptCallFn, onExecuted). */
  readonly hookExtras?: Omit<CreateHookMiddlewareOptions, "hooks"> | undefined;
  /**
   * When true, always install a hook-middleware slot even for empty
   * hook sets. Hosts with an observer tap (TUI records trace spans
   * through `onExecuted`) need the slot to stay; plain CLI omits it.
   */
  readonly forceHookSlot?: boolean;
  /** Optional system prompt; omitted → no system-prompt middleware. */
  readonly systemPrompt?: string | undefined;
  /** Optional session transcript; omitted → no session-transcript middleware. */
  readonly session?:
    | { readonly transcript: SessionTranscript; readonly sessionId: SessionId }
    | undefined;
}

/** Tagged slot record — each slot is `undefined` when its config opts out. */
export interface CoreMiddlewareSlots {
  readonly permissions: KoiMiddleware;
  readonly hook: KoiMiddleware | undefined;
  readonly systemPrompt: KoiMiddleware | undefined;
  readonly sessionTranscript: KoiMiddleware | undefined;
}

/**
 * Build the core middleware slots both hosts consume. The caller
 * composes these into its own middleware array in whatever order it
 * needs (CLI: outermost → innermost; TUI: wrapped in event-trace /
 * checkpoint / etc). A new core middleware type lands here as a new
 * slot and gains one-place maintenance.
 */
export function buildCoreMiddleware(config: CoreMiddlewareConfig): CoreMiddlewareSlots {
  const hookMw =
    config.forceHookSlot === true
      ? buildHookMw(config.hooks, config.hookExtras)
      : buildHookMwOrUndefined(config.hooks, config.hookExtras);
  return {
    permissions: config.permissionsMiddleware,
    hook: hookMw,
    systemPrompt: buildSystemPromptMw(config.systemPrompt),
    sessionTranscript: buildSessionTranscriptMw(config.session),
  };
}

// ---------------------------------------------------------------------------
// Shared core ComponentProviders
//
// The "core" set is the provider stack both `koi start` and `koi tui` should
// wire out of the box: filesystem read/write/edit, workspace search
// (Glob/Grep/ToolSearch), web_fetch, and shell. Adding a new tool to this
// builder lands in both hosts with one edit — the exact property the user
// asked for ("add a feature in one place, works for both").
//
// The bash tool is passed in as an opaque `Tool` rather than built here so
// the TUI can supply its fancier `createBashToolWithHooks` variant (CWD
// tracking, bash-AST elicit, hook integration) while `koi start` passes a
// plain `createBashTool`. Any other surface differences (Plan Mode,
// `AskUserQuestion`) are handled via the `additional` config field.
// ---------------------------------------------------------------------------

/** Wraps a single `Tool` as a named `ComponentProvider` for createKoi. */
export function wrapToolAsProvider(tool: Tool): ComponentProvider {
  const name = tool.descriptor.name;
  return {
    name,
    attach: async (): Promise<ReadonlyMap<string, unknown>> =>
      new Map([[toolToken(name) as unknown as string, tool]]),
  };
}

export interface CoreProvidersConfig {
  /** Workspace root — threaded into filesystem-scoped builders (Glob, fs tools). */
  readonly cwd: string;
  /**
   * Host-provided bash tool. Normally supplied by the execution preset
   * stack's `bashHandle.tool`. When `undefined` (execution stack
   * disabled via `manifest.stacks`), the core set omits the `Bash`
   * provider — the host runs without shell access.
   */
  readonly bashTool?: Tool | undefined;
  /**
   * When true, wire fs_read / fs_write / fs_edit via the local filesystem
   * backend with the unsandboxed policy. Defaults to `true` — a new host
   * opts out only when it runs against a remote/virtual filesystem and
   * wants its own backend bound here.
   */
  readonly includeFilesystemTools?: boolean;
  /**
   * When true, wire the web_fetch tool. Defaults to `true` — hosts that
   * run in airgapped environments can pass `false` to strip network access.
   */
  readonly includeWebFetch?: boolean;
  /**
   * Host-specific extra providers appended after the core set (e.g. TUI's
   * bash_background, task tools, memory, notebook, spawn). Added here
   * rather than by the caller splicing arrays so the assembly order is
   * always `[core..., extras...]` and reviewers can spot-check the spread.
   */
  readonly additional?: readonly ComponentProvider[];
}

/**
 * Build the core `ComponentProvider[]` both hosts consume.
 *
 * Order matters for debug/telemetry grouping, not for runtime semantics —
 * createKoi treats providers as an unordered set. The order here is
 * search → filesystem → web → shell so a human reading a trace spots
 * read-before-mutate tools first.
 */
export function buildCoreProviders(config: CoreProvidersConfig): ComponentProvider[] {
  const { cwd, bashTool } = config;
  const includeFs = config.includeFilesystemTools ?? true;
  const includeWeb = config.includeWebFetch ?? true;

  const providers: ComponentProvider[] = [createBuiltinSearchProvider({ cwd })];

  if (includeFs) {
    // allowExternalPaths: the runtime has a real permission middleware
    // (path-aware rules + approval handler) that gates out-of-workspace access.
    const localFs = createLocalFileSystem(cwd, { allowExternalPaths: true });
    providers.push(
      createSingleToolProvider({
        name: "fs-read",
        toolName: "fs_read",
        createTool: () => createFsReadTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
      }),
      createSingleToolProvider({
        name: "fs-write",
        toolName: "fs_write",
        createTool: () => createFsWriteTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
      }),
      createSingleToolProvider({
        name: "fs-edit",
        toolName: "fs_edit",
        createTool: () => createFsEditTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
      }),
    );
  }

  if (includeWeb) {
    const webExecutor = createWebExecutor({ allowHttps: true });
    providers.push(
      createWebProvider({
        executor: webExecutor,
        policy: DEFAULT_UNSANDBOXED_POLICY,
        operations: ["fetch"],
      }),
    );
  }

  if (bashTool !== undefined) {
    providers.push(wrapToolAsProvider(bashTool));
  }

  if (config.additional !== undefined) {
    providers.push(...config.additional);
  }

  return providers;
}
