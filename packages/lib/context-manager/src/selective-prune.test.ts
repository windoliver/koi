import { describe, expect, it } from "bun:test";
import { assistantWithToolUse, charEstimator, textMsg } from "./__tests__/test-helpers.js";
import { selectivelyPrune } from "./selective-prune.js";

function toolPair(
  callId: string,
  toolText = callId,
): readonly [ReturnType<typeof assistantWithToolUse>, ReturnType<typeof textMsg>] {
  return [assistantWithToolUse(callId), textMsg(toolText, "tool", callId)];
}

describe("selectivelyPrune", () => {
  it("exactly K pairs -> no pruning", async () => {
    const messages = [
      textMsg("system", "system"),
      textMsg("user"),
      ...toolPair("a"),
      ...toolPair("b"),
      textMsg("last user"),
    ];

    const result = await selectivelyPrune(messages, 2, charEstimator);

    expect(result.messages).toBe(messages);
    expect(result.pairsRemoved).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.events).toEqual([]);
  });

  it("K-1 pairs -> no pruning", async () => {
    const messages = [textMsg("user"), ...toolPair("a"), textMsg("last user")];

    const result = await selectivelyPrune(messages, 2, charEstimator);

    expect(result.messages).toBe(messages);
    expect(result.pairsRemoved).toBe(0);
    expect(result.events).toEqual([]);
  });

  it("K+1 pairs -> prunes 1 oldest pair", async () => {
    const system = textMsg("system", "system");
    const middleUser = textMsg("middle user");
    const lastUser = textMsg("last user");
    const pairA = toolPair("a", "aaaa");
    const pairB = toolPair("b", "bbbb");
    const pairC = toolPair("c", "cccc");
    const messages = [system, ...pairA, middleUser, ...pairB, ...pairC, lastUser];

    const result = await selectivelyPrune(messages, 2, charEstimator);

    expect(result.pairsRemoved).toBe(1);
    expect(result.tokensSaved).toBe(4);
    expect(result.messages).toEqual([system, middleUser, ...pairB, ...pairC, lastUser]);
    expect(result.events).toEqual([
      {
        kind: "tool_output.pruned",
        pairsRemoved: 1,
        tokensSaved: 4,
      },
    ]);
  });

  it("preserves pair atomicity when pruning", async () => {
    const messages = [textMsg("user"), ...toolPair("a", "aaaa"), ...toolPair("b", "bbbb")];

    const result = await selectivelyPrune(messages, 0, charEstimator);

    expect(result.messages.some((msg) => msg.metadata?.callId === "a")).toBe(false);
    expect(result.messages.some((msg) => msg.metadata?.callId === "b")).toBe(false);
  });

  it("never removes system or user messages", async () => {
    const system = textMsg("system", "system");
    const firstUser = textMsg("first user");
    const middleUser = textMsg("middle user");
    const lastUser = textMsg("last user");
    const pairA = toolPair("a", "aaaa");
    const pairB = toolPair("b", "bbbb");
    const messages = [system, firstUser, ...pairA, middleUser, ...pairB, lastUser];

    const result = await selectivelyPrune(messages, 1, charEstimator);

    expect(result.messages).toEqual([system, firstUser, middleUser, ...pairB, lastUser]);
  });

  it("never removes the last user message", async () => {
    const lastUser = textMsg("keep me");
    const messages = [textMsg("user"), ...toolPair("a", "aaaa"), lastUser];

    const result = await selectivelyPrune(messages, 0, charEstimator);

    expect(result.messages[result.messages.length - 1]).toBe(lastUser);
  });

  it("prunePreserveLastK=0 -> removes all pairs", async () => {
    const system = textMsg("system", "system");
    const user = textMsg("user");
    const between = textMsg("between");
    const lastUser = textMsg("last user");
    const pairA = toolPair("a", "aaaa");
    const pairB = toolPair("b", "bbbb");
    const messages = [system, user, ...pairA, between, ...pairB, lastUser];

    const result = await selectivelyPrune(messages, 0, charEstimator);

    expect(result.pairsRemoved).toBe(2);
    expect(result.tokensSaved).toBe(8);
    expect(result.messages).toEqual([system, user, between, lastUser]);
  });
});
