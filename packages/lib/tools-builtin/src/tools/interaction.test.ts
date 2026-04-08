import { describe, expect, mock, test } from "bun:test";
import type { ElicitationResult } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { createAskUserTool } from "./ask-user.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "./plan-mode.js";
import type { TodoItem } from "./todo.js";
import { createTodoTool } from "./todo.js";

// ---------------------------------------------------------------------------
// TodoWrite
// ---------------------------------------------------------------------------

describe("createTodoTool", () => {
  function makeStore(initial: readonly TodoItem[] = []): {
    getItems: () => readonly TodoItem[];
    setItems: (items: readonly TodoItem[]) => void;
    items: () => readonly TodoItem[];
  } {
    let stored: readonly TodoItem[] = initial;
    return {
      getItems: () => stored,
      setItems: (items) => {
        stored = items;
      },
      items: () => stored,
    };
  }

  test("writes items and returns them", async () => {
    const store = makeStore();
    const tool = createTodoTool({ getItems: store.getItems, setItems: store.setItems });
    const result = (await tool.execute({
      todos: [
        { id: "a", content: "Write tests", status: "in_progress" },
        { id: "b", content: "Write code", status: "pending" },
      ],
    })) as { todos: readonly TodoItem[]; cleared: boolean };

    expect(result.todos).toHaveLength(2);
    expect(result.todos[0]?.id).toBe("a");
    expect(result.cleared).toBe(false);
    expect(store.items()).toHaveLength(2);
  });

  test("auto-clears when all items are completed", async () => {
    const store = makeStore();
    const tool = createTodoTool({ getItems: store.getItems, setItems: store.setItems });
    const result = (await tool.execute({
      todos: [
        { id: "a", content: "Task A", status: "completed" },
        { id: "b", content: "Task B", status: "completed" },
      ],
    })) as { todos: readonly TodoItem[]; cleared: boolean };

    expect(result.cleared).toBe(true);
    expect(result.todos).toHaveLength(0);
    expect(store.items()).toHaveLength(0);
  });

  test("does not clear if any item is not completed", async () => {
    const store = makeStore();
    const tool = createTodoTool({ getItems: store.getItems, setItems: store.setItems });
    const result = (await tool.execute({
      todos: [
        { id: "a", content: "Task A", status: "completed" },
        { id: "b", content: "Task B", status: "pending" },
      ],
    })) as { todos: readonly TodoItem[]; cleared: boolean };

    expect(result.cleared).toBe(false);
    expect(result.todos).toHaveLength(2);
  });

  test("returns validation error for missing id", async () => {
    const store = makeStore();
    const tool = createTodoTool({ getItems: store.getItems, setItems: store.setItems });
    const result = (await tool.execute({
      todos: [{ content: "No ID here", status: "pending" }],
    })) as { error: string; code: string };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("id");
  });

  test("returns validation error for invalid status", async () => {
    const store = makeStore();
    const tool = createTodoTool({ getItems: store.getItems, setItems: store.setItems });
    const result = (await tool.execute({
      todos: [{ id: "x", content: "Task", status: "done" }],
    })) as { error: string; code: string };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("status");
  });

  test("returns validation error when todos is not an array", async () => {
    const store = makeStore();
    const tool = createTodoTool({ getItems: store.getItems, setItems: store.setItems });
    const result = (await tool.execute({ todos: "not-an-array" })) as {
      error: string;
      code: string;
    };

    expect(result.code).toBe("VALIDATION");
  });

  test("uses provided policy", () => {
    const store = makeStore();
    const tool = createTodoTool({
      getItems: store.getItems,
      setItems: store.setItems,
      policy: DEFAULT_SANDBOXED_POLICY,
    });
    expect(tool.policy.sandbox).toBe(true);
  });

  test("descriptor has correct name", () => {
    const store = makeStore();
    const tool = createTodoTool({ getItems: store.getItems, setItems: store.setItems });
    expect(tool.descriptor.name).toBe("TodoWrite");
    expect(tool.origin).toBe("primordial");
  });
});

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

describe("createAskUserTool", () => {
  const mockQuestions = [
    {
      question: "Which approach?",
      options: [
        { label: "Option A", description: "Faster but less flexible" },
        { label: "Option B", description: "Slower but more flexible" },
      ],
    },
  ];

  test("calls elicit and returns answers", async () => {
    const mockResults: readonly ElicitationResult[] = [{ selected: ["Option A"] }];
    const elicit = mock(async () => mockResults);
    const tool = createAskUserTool({ elicit });

    const result = (await tool.execute({ questions: mockQuestions })) as {
      answers: Array<{ question: string; selected: readonly string[] }>;
    };

    expect(elicit).toHaveBeenCalledTimes(1);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]?.selected).toEqual(["Option A"]);
  });

  test("returns error when channels are active", async () => {
    const elicit = mock(async () => []);
    const tool = createAskUserTool({
      elicit,
      isChannelsActive: () => true,
    });

    const result = (await tool.execute({ questions: mockQuestions })) as {
      error: string;
      code: string;
    };

    expect(result.code).toBe("UNAVAILABLE");
    expect(elicit).not.toHaveBeenCalled();
  });

  test("returns validation error when questions is empty", async () => {
    const elicit = mock(async () => []);
    const tool = createAskUserTool({ elicit });

    const result = (await tool.execute({ questions: [] })) as { error: string; code: string };

    expect(result.code).toBe("VALIDATION");
    expect(elicit).not.toHaveBeenCalled();
  });

  test("returns validation error when more than 4 questions", async () => {
    const elicit = mock(async () => []);
    const tool = createAskUserTool({ elicit });
    const manyQuestions = Array.from({ length: 5 }, (_, i) => ({
      question: `Q${String(i)}?`,
      options: [
        { label: "A", description: "Option A" },
        { label: "B", description: "Option B" },
      ],
    }));

    const result = (await tool.execute({ questions: manyQuestions })) as {
      error: string;
      code: string;
    };

    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for question with fewer than 2 options", async () => {
    const elicit = mock(async () => []);
    const tool = createAskUserTool({ elicit });

    const result = (await tool.execute({
      questions: [
        {
          question: "One option only?",
          options: [{ label: "Only", description: "Just one" }],
        },
      ],
    })) as { error: string; code: string };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("2");
  });

  test("descriptor has correct name", () => {
    const tool = createAskUserTool({ elicit: async () => [] });
    expect(tool.descriptor.name).toBe("AskUserQuestion");
    expect(tool.origin).toBe("primordial");
  });

  test("uses provided policy", () => {
    const tool = createAskUserTool({
      elicit: async () => [],
      policy: DEFAULT_SANDBOXED_POLICY,
    });
    expect(tool.policy.sandbox).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EnterPlanMode
// ---------------------------------------------------------------------------

describe("createEnterPlanModeTool", () => {
  test("calls enterPlanMode and returns confirmation", async () => {
    const enterPlanMode = mock(() => {});
    const tool = createEnterPlanModeTool({
      isAgentContext: () => false,
      isInPlanMode: () => false,
      enterPlanMode,
    });

    const result = (await tool.execute({})) as { message: string };

    expect(enterPlanMode).toHaveBeenCalledTimes(1);
    expect(result.message).toContain("plan mode");
  });

  test("returns FORBIDDEN when called from agent context", async () => {
    const enterPlanMode = mock(() => {});
    const tool = createEnterPlanModeTool({
      isAgentContext: () => true,
      isInPlanMode: () => false,
      enterPlanMode,
    });

    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("FORBIDDEN");
    expect(enterPlanMode).not.toHaveBeenCalled();
  });

  test("returns CONFLICT when already in plan mode", async () => {
    const enterPlanMode = mock(() => {});
    const tool = createEnterPlanModeTool({
      isAgentContext: () => false,
      isInPlanMode: () => true,
      enterPlanMode,
    });

    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("CONFLICT");
    expect(enterPlanMode).not.toHaveBeenCalled();
  });

  test("returns UNAVAILABLE when channels active", async () => {
    const enterPlanMode = mock(() => {});
    const tool = createEnterPlanModeTool({
      isAgentContext: () => false,
      isInPlanMode: () => false,
      enterPlanMode,
      isChannelsActive: () => true,
    });

    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("UNAVAILABLE");
    expect(enterPlanMode).not.toHaveBeenCalled();
  });

  test("descriptor has correct name", () => {
    const tool = createEnterPlanModeTool({
      isAgentContext: () => false,
      isInPlanMode: () => false,
      enterPlanMode: () => {},
    });
    expect(tool.descriptor.name).toBe("EnterPlanMode");
    expect(tool.origin).toBe("primordial");
  });
});

// ---------------------------------------------------------------------------
// ExitPlanMode — main thread path
// ---------------------------------------------------------------------------

describe("createExitPlanModeTool (main thread)", () => {
  function makeConfig(overrides: Partial<Parameters<typeof createExitPlanModeTool>[0]> = {}) {
    return createExitPlanModeTool({
      isInPlanMode: () => true,
      isTeammate: false,
      isPlanModeRequired: false,
      exitPlanMode: () => {},
      getPlanContent: async () => "## Plan\nDo the thing",
      ...overrides,
    });
  }

  test("exits plan mode and returns approved result", async () => {
    const exitPlanMode = mock(() => {});
    const tool = makeConfig({ exitPlanMode });

    const result = (await tool.execute({})) as { approved: boolean; message: string };

    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(result.approved).toBe(true);
    expect(result.message).toContain("approved");
  });

  test("includes plan content in result", async () => {
    const tool = makeConfig({ getPlanContent: async () => "## My Plan\nStep 1\nStep 2" });

    const result = (await tool.execute({})) as { message: string };

    expect(result.message).toContain("My Plan");
  });

  test("returns CONFLICT when not in plan mode", async () => {
    const tool = makeConfig({ isInPlanMode: () => false });

    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("CONFLICT");
  });

  test("returns UNAVAILABLE when channels active", async () => {
    const tool = makeConfig({ isChannelsActive: () => true });

    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("UNAVAILABLE");
  });

  test("calls savePlanContent if provided", async () => {
    const savePlanContent = mock(async (_content: string) => {});
    const tool = makeConfig({ savePlanContent });

    await tool.execute({});

    expect(savePlanContent).toHaveBeenCalledWith("## Plan\nDo the thing");
  });

  test("includes team hint when hasTeamCreateTool returns true", async () => {
    const tool = makeConfig({ hasTeamCreateTool: () => true });
    const result = (await tool.execute({})) as { message: string };

    expect(result.message).toContain("TeamCreate");
  });
});

// ---------------------------------------------------------------------------
// ExitPlanMode — swarm teammate path
// ---------------------------------------------------------------------------

describe("createExitPlanModeTool (teammate)", () => {
  function makeTeammateConfig(
    overrides: Partial<Parameters<typeof createExitPlanModeTool>[0]> = {},
  ) {
    return createExitPlanModeTool({
      isInPlanMode: () => true,
      isTeammate: true,
      isPlanModeRequired: true,
      exitPlanMode: () => {},
      getPlanContent: async () => "## Teammate Plan\nStep 1",
      getAgentName: () => "researcher",
      getTeamName: () => "team-alpha",
      writeToMailbox: async () => {},
      generateRequestId: () => "req-123",
      ...overrides,
    });
  }

  test("writes plan_approval_request to mailbox and returns awaitingLeaderApproval", async () => {
    let capturedMessage: { from: string; text: string } | undefined;
    const writeToMailbox = mock(
      async (
        _recipient: "team-lead",
        message: { from: string; text: string; timestamp: string },
      ) => {
        capturedMessage = message;
      },
    );
    const setAwaitingPlanApproval = mock((_awaiting: boolean) => {});
    const tool = makeTeammateConfig({ writeToMailbox, setAwaitingPlanApproval });

    const result = (await tool.execute({})) as {
      awaitingLeaderApproval: boolean;
      requestId: string;
    };

    expect(result.awaitingLeaderApproval).toBe(true);
    expect(result.requestId).toBe("req-123");
    expect(writeToMailbox).toHaveBeenCalledTimes(1);
    expect(setAwaitingPlanApproval).toHaveBeenCalledWith(true);
    expect(capturedMessage?.from).toBe("researcher");

    const parsed = JSON.parse(capturedMessage?.text ?? "{}") as { type: string };
    expect(parsed.type).toBe("plan_approval_request");
  });

  test("returns NOT_FOUND when no plan content", async () => {
    const tool = makeTeammateConfig({ getPlanContent: async () => undefined });

    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("NOT_FOUND");
  });

  test("returns INTERNAL when writeToMailbox not configured", async () => {
    const tool = makeTeammateConfig({ writeToMailbox: undefined });

    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("INTERNAL");
  });

  test("does NOT call exitPlanMode (stays in plan mode until lead approves)", async () => {
    const exitPlanMode = mock(() => {});
    const tool = makeTeammateConfig({ exitPlanMode });

    await tool.execute({});

    expect(exitPlanMode).not.toHaveBeenCalled();
  });

  test("descriptor has correct name", () => {
    const tool = makeTeammateConfig();
    expect(tool.descriptor.name).toBe("ExitPlanMode");
  });

  test("uses provided policy", () => {
    const tool = makeTeammateConfig({ policy: DEFAULT_SANDBOXED_POLICY });
    expect(tool.policy.sandbox).toBe(true);
  });
});
