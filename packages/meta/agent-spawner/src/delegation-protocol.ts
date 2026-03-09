/**
 * Delegation protocol — builds CLI arguments and parses output
 * for both stdio and ACP code paths.
 */

import { buildRequest, createLineParser } from "@koi/acp-protocol";
import type { KoiError, Result, SandboxAdapterResult } from "@koi/core";
import type { DelegationFailureKind } from "./types.js";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

/** Default timeout for agent invocations: 5 minutes. */
export const DEFAULT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Stdio path
// ---------------------------------------------------------------------------

/** Build argv for a stdio-mode agent invocation. */
export function buildStdioArgs(command: string, prompt: string, model?: string): readonly string[] {
  const args: string[] = [command, "--print", prompt];
  if (model !== undefined) {
    args.push("--model", model);
  }
  return args;
}

/** Classify a stdio result into a KoiError failure kind. */
function classifyStdioFailure(exitCode: number, timedOut: boolean): DelegationFailureKind {
  if (timedOut) return "TIMEOUT";
  if (exitCode !== 0) return "SPAWN_FAILED";
  return "PARSE_FAILED";
}

/** Map DelegationFailureKind to KoiErrorCode. */
function mapFailureKindToErrorCode(kind: DelegationFailureKind): KoiError["code"] {
  switch (kind) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "SPAWN_FAILED":
      return "EXTERNAL";
    case "PARSE_FAILED":
      return "EXTERNAL";
  }
}

/** Whether a failure kind is retryable. */
function isRetryable(kind: DelegationFailureKind): boolean {
  return kind === "SPAWN_FAILED" || kind === "TIMEOUT";
}

/** Parse the output of a stdio-mode agent invocation. */
export function parseStdioOutput(result: SandboxAdapterResult): Result<string, KoiError> {
  if (result.timedOut) {
    const kind: DelegationFailureKind = "TIMEOUT";
    // If there's partial output before timeout, return it
    const partial = result.stdout.trim();
    if (partial.length > 0) {
      return { ok: true, value: partial };
    }
    return {
      ok: false,
      error: {
        code: mapFailureKindToErrorCode(kind),
        message: "Agent timed out with no output",
        retryable: isRetryable(kind),
        context: { kind },
      },
    };
  }

  if (result.exitCode !== 0) {
    const kind = classifyStdioFailure(result.exitCode, false);
    return {
      ok: false,
      error: {
        code: mapFailureKindToErrorCode(kind),
        message: `Agent exited with code ${String(result.exitCode)}: ${result.stderr.slice(0, 500)}`,
        retryable: isRetryable(kind),
        context: { kind, exitCode: result.exitCode },
      },
    };
  }

  const output = result.stdout.trim();
  if (output.length === 0) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: "Agent produced empty output",
        retryable: false,
        context: { kind: "PARSE_FAILED" satisfies DelegationFailureKind },
      },
    };
  }

  return { ok: true, value: output };
}

// ---------------------------------------------------------------------------
// ACP path
// ---------------------------------------------------------------------------

/** Build argv for an ACP-mode agent invocation. */
export function buildAcpArgs(command: string, model?: string): readonly string[] {
  const args: string[] = [command, "--acp"];
  if (model !== undefined) {
    args.push("--model", model);
  }
  return args;
}

/**
 * Build newline-delimited JSON-RPC stdin for an ACP session.
 *
 * Uses a pre-allocated session ID so the session/new response and session/prompt
 * request agree on the same ID. This is necessary because stdin is pre-built as a
 * single string (batch mode) — we cannot read the session/new response before
 * sending session/prompt.
 *
 * TODO: Implement interactive ACP session handling where the spawner reads the
 * session/new response before sending session/prompt, supporting ACP servers that
 * allocate server-side session IDs.
 */
export function buildAcpStdin(prompt: string): string {
  // Pre-allocate a client-side session ID so both session/new and session/prompt
  // reference the same value. ACP servers that honour client-suggested IDs will
  // accept this; servers that allocate their own IDs require interactive handling.
  const clientSessionId = `koi-spawn-${Date.now()}`;

  const init = buildRequest("initialize", {
    protocolVersion: "0.1",
    clientInfo: { name: "koi-agent-spawner", version: "0.0.0" },
    capabilities: {},
  });
  const session = buildRequest("session/new", { sessionId: clientSessionId });
  const promptReq = buildRequest("session/prompt", {
    sessionId: clientSessionId,
    messages: [{ role: "user", content: prompt }],
  });

  return `${init.message}\n${session.message}\n${promptReq.message}\n`;
}

/** Extract text output from ACP JSON-RPC stdout. */
export function extractAcpOutput(stdout: string): Result<string, KoiError> {
  const parser = createLineParser();
  const messages = [...parser.feed(stdout), ...parser.flush()];

  const textParts: string[] = [];

  for (const msg of messages) {
    if (msg.kind !== "notification") continue;
    if (msg.method !== "session/update") continue;

    const params = msg.params as
      | { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }
      | undefined;

    if (params?.content === undefined) continue;

    for (const block of params.content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }
  }

  const output = textParts.join("").trim();
  if (output.length === 0) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: "ACP agent produced no text output",
        retryable: false,
        context: { kind: "PARSE_FAILED" satisfies DelegationFailureKind },
      },
    };
  }

  return { ok: true, value: output };
}
