/**
 * @koi/rules-loader — KoiMiddleware factory.
 *
 * Wires discovery, loading, and merging into the agent session lifecycle.
 * Injects merged rules into request.systemPrompt on every model call.
 */

import { stat } from "node:fs/promises";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  ModelStreamHandler,
  SessionId,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

import {
  type LoadedFile,
  type MergedRuleset,
  type RulesLoaderConfig,
  validateRulesLoaderConfig,
} from "./config.js";
import { discoverRulesFiles } from "./discover.js";
import { findGitRoot } from "./find-git-root.js";
import { loadAllRulesFiles } from "./load.js";
import { mergeRulesets } from "./merge.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface RulesSessionState {
  readonly ruleset: MergedRuleset;
  readonly loadedFiles: readonly LoadedFile[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if any cached file's mtime has changed. */
async function hasFilesChanged(files: readonly LoadedFile[]): Promise<boolean> {
  for (const file of files) {
    try {
      const s = await stat(file.path);
      if (s.mtimeMs !== file.mtimeMs) return true;
    } catch {
      // File disappeared — counts as changed
      return true;
    }
  }
  return false;
}

/** Prepend rules content to a model request's systemPrompt. */
function injectRules(request: ModelRequest, ruleset: MergedRuleset): ModelRequest {
  if (ruleset.content.length === 0) return request;
  const systemPrompt =
    request.systemPrompt !== undefined
      ? `${ruleset.content}\n\n${request.systemPrompt}`
      : ruleset.content;
  return { ...request, systemPrompt };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a KoiMiddleware that discovers, loads, and injects hierarchical
 * project rules files into the agent's system prompt.
 */
export function createRulesMiddleware(config?: RulesLoaderConfig): KoiMiddleware {
  const result = validateRulesLoaderConfig(config);
  if (!result.ok) {
    throw KoiRuntimeError.from(result.error.code, result.error.message);
  }
  const resolved = result.value;
  const sessions = new Map<SessionId, RulesSessionState>();

  /** Perform full discovery → load → merge cycle using current cwd. */
  async function loadRules(): Promise<RulesSessionState> {
    const cwd = resolved.getCwd();
    const gitRoot = await findGitRoot(cwd);
    const discovered = await discoverRulesFiles(cwd, gitRoot, resolved.scanPaths);
    const loadedFiles = await loadAllRulesFiles(discovered);
    const ruleset = mergeRulesets(loadedFiles, resolved.maxTokens);
    return { ruleset, loadedFiles };
  }

  return {
    name: "rules",
    priority: 200,

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      if (!resolved.enabled) return undefined;
      const state = sessions.get(ctx.session.sessionId);
      if (state === undefined || state.ruleset.files.length === 0) return undefined;
      return {
        label: "rules",
        description: `Project rules: ${String(state.ruleset.files.length)} files, ${String(state.ruleset.estimatedTokens)} tokens`,
      };
    },

    async onSessionStart(ctx) {
      if (!resolved.enabled) return;
      let state: RulesSessionState;
      try {
        state = await loadRules();
      } catch (e: unknown) {
        console.warn(
          "[rules-loader] Failed to load rules at session start, continuing without rules:",
          e instanceof Error ? e.message : e,
        );
        return;
      }
      sessions.set(ctx.sessionId, state);

      if (state.ruleset.files.length > 0 && state.ruleset.truncated) {
        console.warn(
          `[rules-loader] Token budget exceeded: ${String(state.ruleset.estimatedTokens)} tokens from ${String(state.ruleset.files.length)} files (truncated)`,
        );
      }
    },

    async onBeforeTurn(ctx) {
      if (!resolved.enabled) return;
      const state = sessions.get(ctx.session.sessionId);
      if (state === undefined) return;

      try {
        const cwd = resolved.getCwd();
        const gitRoot = await findGitRoot(cwd);
        const discovered = await discoverRulesFiles(cwd, gitRoot, resolved.scanPaths);

        const discoveredPaths = new Set(discovered.map((d) => d.path));
        const cachedPaths = new Set(state.loadedFiles.map((f) => f.path));
        const filesAdded = discovered.some((d) => !cachedPaths.has(d.path));
        const filesRemoved = state.loadedFiles.some((f) => !discoveredPaths.has(f.path));

        if (filesAdded || filesRemoved || (await hasFilesChanged(state.loadedFiles))) {
          const refreshed = await loadRules();
          sessions.set(ctx.session.sessionId, refreshed);
        }
      } catch (e: unknown) {
        console.warn(
          "[rules-loader] Failed to refresh rules, keeping cached version:",
          e instanceof Error ? e.message : e,
        );
      }
    },

    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (state === undefined) return next(request);
      return next(injectRules(request, state.ruleset));
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<import("@koi/core").ModelChunk> {
      const state = sessions.get(ctx.session.sessionId);
      if (state === undefined) {
        yield* next(request);
        return;
      }
      yield* next(injectRules(request, state.ruleset));
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request);
    },

    async onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
    },
  };
}
