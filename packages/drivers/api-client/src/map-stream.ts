/**
 * Map Anthropic SDK streaming events to Koi ModelChunk async iterable.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk, ModelResponse } from "@koi/core";
import { toolCallId } from "@koi/core";

type RawEvent = Anthropic.RawMessageStreamEvent;

/**
 * Transform an async iterable of Anthropic SDK streaming events into
 * an async iterable of Koi ModelChunk values.
 *
 * Tracks accumulated text and usage across the stream to produce the
 * final "done" chunk with a complete ModelResponse.
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawEvent>,
  defaultModel: string,
): AsyncIterable<ModelChunk> {
  let accumulatedText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let model = defaultModel;

  // Track active tool calls by content block index
  const activeToolCalls = new Map<number, string>();

  for await (const event of events) {
    const chunks = mapSingleEvent(
      event,
      activeToolCalls,
      (text) => {
        accumulatedText += text;
      },
      (m) => {
        model = m;
      },
      (input, output) => {
        inputTokens = input;
        outputTokens = output;
      },
    );
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  // Emit final done chunk
  const response: ModelResponse = {
    content: accumulatedText,
    model,
    usage: { inputTokens, outputTokens },
  };
  yield { kind: "done", response };
}

/** Map a single SDK event to zero or more ModelChunk values. */
function mapSingleEvent(
  event: RawEvent,
  activeToolCalls: Map<number, string>,
  appendText: (text: string) => void,
  setModel: (model: string) => void,
  setUsage: (input: number, output: number) => void,
): readonly ModelChunk[] {
  switch (event.type) {
    case "message_start": {
      setModel(event.message.model);
      setUsage(event.message.usage.input_tokens, event.message.usage.output_tokens);
      return [];
    }

    case "content_block_start": {
      if (event.content_block.type === "tool_use") {
        const callId = event.content_block.id;
        activeToolCalls.set(event.index, callId);
        return [
          {
            kind: "tool_call_start",
            toolName: event.content_block.name,
            callId: toolCallId(callId),
          },
        ];
      }
      return [];
    }

    case "content_block_delta": {
      return mapDelta(event, activeToolCalls, appendText);
    }

    case "content_block_stop": {
      const callId = activeToolCalls.get(event.index);
      if (callId !== undefined) {
        activeToolCalls.delete(event.index);
        return [{ kind: "tool_call_end", callId: toolCallId(callId) }];
      }
      return [];
    }

    case "message_delta": {
      const usage = event.usage;
      if (usage !== undefined) {
        setUsage(0, usage.output_tokens);
        return [{ kind: "usage", inputTokens: 0, outputTokens: usage.output_tokens }];
      }
      return [];
    }

    case "message_stop":
      // Done is emitted after the loop in mapAnthropicStream
      return [];

    default:
      return [];
  }
}

/** Map a content_block_delta event to ModelChunk(s). */
function mapDelta(
  event: Anthropic.RawContentBlockDeltaEvent,
  activeToolCalls: Map<number, string>,
  appendText: (text: string) => void,
): readonly ModelChunk[] {
  const delta = event.delta;

  switch (delta.type) {
    case "text_delta": {
      appendText(delta.text);
      return [{ kind: "text_delta", delta: delta.text }];
    }
    case "thinking_delta": {
      return [{ kind: "thinking_delta", delta: delta.thinking }];
    }
    case "input_json_delta": {
      const callId = activeToolCalls.get(event.index);
      if (callId !== undefined) {
        return [{ kind: "tool_call_delta", callId: toolCallId(callId), delta: delta.partial_json }];
      }
      return [];
    }
    default:
      // signature_delta, citations_delta — no Koi mapping needed
      return [];
  }
}
