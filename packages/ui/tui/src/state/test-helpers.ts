/**
 * Test factory functions for TUI state tests.
 *
 * Pattern matches @koi/context-manager's test-helpers.ts:
 * Partial<TuiState> overrides, minimal message builders.
 */

import type { ToolCallId } from "@koi/core/ecs";
import type { EngineEvent } from "@koi/core/engine";
import { createInitialState } from "./initial.js";
import type { TuiAction, TuiAssistantBlock, TuiMessage, TuiState } from "./types.js";

/** Create a TuiState with partial overrides on top of initial defaults. */
export function stateWith(overrides: Partial<TuiState>): TuiState {
  return { ...createInitialState(), ...overrides };
}

/** Wrap an EngineEvent in the coarse action wrapper. */
export function engineEvent(event: EngineEvent): TuiAction {
  return { kind: "engine_event", event };
}

/** Create a user message with text content. */
export function userMsg(text: string, id = "user-0"): TuiMessage {
  return {
    kind: "user",
    id,
    blocks: [{ kind: "text", text }],
  };
}

/** Create an assistant message with a single text block. */
export function assistantMsg(
  text: string,
  opts?: {
    readonly id?: string;
    readonly streaming?: boolean;
    readonly blocks?: readonly TuiAssistantBlock[];
  },
): TuiMessage {
  const blocks: readonly TuiAssistantBlock[] = opts?.blocks ?? [{ kind: "text", text }];
  return {
    kind: "assistant",
    id: opts?.id ?? "assistant-0",
    blocks,
    streaming: opts?.streaming ?? false,
  };
}

/** Create a system message. */
export function systemMsg(text: string, id = "system-0"): TuiMessage {
  return { kind: "system", id, text };
}

/** Extract the last message from state. Throws if empty. */
export function lastMessage(state: TuiState): TuiMessage {
  const msg = state.messages.at(-1);
  if (!msg) throw new Error("No messages in state");
  return msg;
}

/** Extract text from the last assistant message's first text block. */
export function lastAssistantText(state: TuiState): string {
  const msg = lastMessage(state);
  if (msg.kind !== "assistant") throw new Error("Last message is not assistant");
  const block = msg.blocks.find((b) => b.kind === "text");
  if (!block) throw new Error("No text block in assistant message");
  return block.text;
}

/** Safely get a message by index. Throws if out of bounds. */
export function messageAt(state: TuiState, idx: number): TuiMessage {
  const msg = state.messages[idx];
  if (!msg) throw new Error(`No message at index ${idx}`);
  return msg;
}

/** Safely get a block by index from an assistant message. Throws if not assistant. */
export function blockAt(msg: TuiMessage, idx: number): TuiAssistantBlock {
  if (msg.kind !== "assistant") throw new Error("Not an assistant message");
  const block = msg.blocks[idx];
  if (!block) throw new Error(`No block at index ${idx}`);
  return block;
}

/** Create a branded ToolCallId for tests (cast — safe in test context). */
export function testCallId(id: string): ToolCallId {
  return id as ToolCallId;
}
