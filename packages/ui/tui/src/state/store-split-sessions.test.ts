import { describe, expect, test } from "bun:test";
import { reduce } from "./store.js";
import { createInitialState, type SessionState, type TuiState } from "./types.js";

const BASE_STATE = createInitialState("http://localhost:3100");

function makeSession(agentId: string, sessionId: string): SessionState {
  return {
    agentId,
    sessionId,
    messages: [],
    pendingText: "",
    isStreaming: false,
  };
}

describe("reduce — set_split_session", () => {
  test("adds a new session", () => {
    const session = makeSession("a1", "s1");
    const next = reduce(BASE_STATE, {
      kind: "set_split_session",
      agentId: "a1",
      session,
    });
    expect(next.splitSessions["a1"]).toEqual(session);
  });

  test("updates an existing session", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: { a1: makeSession("a1", "s1") },
    };
    const updated = { ...makeSession("a1", "s2"), isStreaming: true };
    const next = reduce(state, {
      kind: "set_split_session",
      agentId: "a1",
      session: updated,
    });
    expect(next.splitSessions["a1"]?.sessionId).toBe("s2");
    expect(next.splitSessions["a1"]?.isStreaming).toBe(true);
  });

  test("preserves other sessions", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: { a1: makeSession("a1", "s1") },
    };
    const next = reduce(state, {
      kind: "set_split_session",
      agentId: "a2",
      session: makeSession("a2", "s2"),
    });
    expect(Object.keys(next.splitSessions)).toHaveLength(2);
    expect(next.splitSessions["a1"]).toEqual(makeSession("a1", "s1"));
    expect(next.splitSessions["a2"]).toEqual(makeSession("a2", "s2"));
  });
});

describe("reduce — remove_split_session", () => {
  test("removes an existing session", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: {
        a1: makeSession("a1", "s1"),
        a2: makeSession("a2", "s2"),
      },
    };
    const next = reduce(state, {
      kind: "remove_split_session",
      agentId: "a1",
    });
    expect(next.splitSessions["a1"]).toBeUndefined();
    expect(next.splitSessions["a2"]).toEqual(makeSession("a2", "s2"));
  });

  test("no-ops on missing agent id", () => {
    const next = reduce(BASE_STATE, {
      kind: "remove_split_session",
      agentId: "nonexistent",
    });
    expect(next.splitSessions).toEqual({});
  });
});

describe("reduce — append_split_tokens", () => {
  test("appends to correct session", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: {
        a1: { ...makeSession("a1", "s1"), pendingText: "Hello" },
        a2: makeSession("a2", "s2"),
      },
    };
    const next = reduce(state, {
      kind: "append_split_tokens",
      agentId: "a1",
      text: " world",
    });
    expect(next.splitSessions["a1"]?.pendingText).toBe("Hello world");
    // Other session untouched
    expect(next.splitSessions["a2"]?.pendingText).toBe("");
  });

  test("no-ops on missing agent id", () => {
    const next = reduce(BASE_STATE, {
      kind: "append_split_tokens",
      agentId: "nonexistent",
      text: "hi",
    });
    expect(next).toBe(BASE_STATE);
  });
});

describe("reduce — flush_split_tokens", () => {
  test("flushes pending text to messages", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: {
        a1: { ...makeSession("a1", "s1"), pendingText: "flushed text", isStreaming: true },
      },
    };
    const next = reduce(state, {
      kind: "flush_split_tokens",
      agentId: "a1",
    });
    const session = next.splitSessions["a1"];
    expect(session?.pendingText).toBe("");
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0]?.kind).toBe("assistant");
    if (session?.messages[0]?.kind === "assistant") {
      expect(session.messages[0].text).toBe("flushed text");
    }
  });

  test("no-ops when pending text is empty", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: {
        a1: makeSession("a1", "s1"),
      },
    };
    const next = reduce(state, {
      kind: "flush_split_tokens",
      agentId: "a1",
    });
    expect(next).toBe(state);
  });

  test("no-ops on missing agent id", () => {
    const next = reduce(BASE_STATE, {
      kind: "flush_split_tokens",
      agentId: "nonexistent",
    });
    expect(next).toBe(BASE_STATE);
  });
});

describe("reduce — set_focused_pane", () => {
  test("sets valid index", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: {
        a1: makeSession("a1", "s1"),
        a2: makeSession("a2", "s2"),
        a3: makeSession("a3", "s3"),
      },
    };
    const next = reduce(state, { kind: "set_focused_pane", index: 1 });
    expect(next.focusedPaneIndex).toBe(1);
  });

  test("clamps to max valid index", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: {
        a1: makeSession("a1", "s1"),
        a2: makeSession("a2", "s2"),
      },
    };
    const next = reduce(state, { kind: "set_focused_pane", index: 100 });
    expect(next.focusedPaneIndex).toBe(1);
  });

  test("clamps negative index to 0", () => {
    const state: TuiState = {
      ...BASE_STATE,
      splitSessions: {
        a1: makeSession("a1", "s1"),
      },
    };
    const next = reduce(state, { kind: "set_focused_pane", index: -5 });
    expect(next.focusedPaneIndex).toBe(0);
  });

  test("clamps to 0 when splitSessions is empty", () => {
    const next = reduce(BASE_STATE, { kind: "set_focused_pane", index: 3 });
    expect(next.focusedPaneIndex).toBe(0);
  });
});

describe("createInitialState — split session defaults", () => {
  test("includes empty splitSessions and focusedPaneIndex 0", () => {
    const s = createInitialState("http://localhost:9200");
    expect(s.splitSessions).toEqual({});
    expect(s.focusedPaneIndex).toBe(0);
  });
});
