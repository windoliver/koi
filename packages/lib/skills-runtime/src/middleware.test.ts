import { describe, expect, test } from "bun:test";
import type {
  Agent,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SkillComponent,
  SubsystemToken,
  TurnContext,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { createSkillInjectorMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAgent(skills: ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent>): Agent {
  return {
    pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      if (prefix === "skill:") {
        return skills as unknown as ReadonlyMap<SubsystemToken<T>, T>;
      }
      return new Map();
    },
    components: () => new Map(),
  } as Agent;
}

function skill(name: string, content: string): [SubsystemToken<SkillComponent>, SkillComponent] {
  const token = `skill:${name}` as SubsystemToken<SkillComponent>;
  return [token, { name, description: `${name} skill`, content }];
}

function mockTurnContext(): TurnContext {
  return {
    session: {
      agentId: "test",
      sessionId: sessionId("test"),
      runId: "run-1" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn-0" as never,
    messages: [],
    metadata: {},
  };
}

function mockRequest(systemPrompt?: string): ModelRequest {
  return {
    messages: [],
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };
}

/** Narrows the optional hooks to required — safe because our middleware always defines them. */
function assertHooks(mw: KoiMiddleware): {
  readonly wrapModelCall: NonNullable<KoiMiddleware["wrapModelCall"]>;
  readonly wrapModelStream: NonNullable<KoiMiddleware["wrapModelStream"]>;
} {
  if (mw.wrapModelCall === undefined || mw.wrapModelStream === undefined) {
    throw new Error("Expected middleware to define wrapModelCall and wrapModelStream");
  }
  return { wrapModelCall: mw.wrapModelCall, wrapModelStream: mw.wrapModelStream };
}

const DONE_RESPONSE: ModelResponse = { content: "ok", model: "test" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillInjectorMiddleware", () => {
  test("passes through unchanged when no skills attached", async () => {
    const agent = mockAgent(new Map());
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest("existing prompt");

    const received: ModelRequest[] = [];
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      received.push(req);
      return DONE_RESPONSE;
    };

    await wrapModelCall(mockTurnContext(), request, next);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(request); // Same reference — no copy
  });

  test("injects single skill content into systemPrompt", async () => {
    const skills = new Map([skill("bullet-points", "Always use bullet points.")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest();

    const received: ModelRequest[] = [];
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      received.push(req);
      return DONE_RESPONSE;
    };

    await wrapModelCall(mockTurnContext(), request, next);

    expect(received).toHaveLength(1);
    expect(received[0]?.systemPrompt).toBe("Always use bullet points.");
  });

  test("concatenates multiple skills sorted by name with separator", async () => {
    // Insert in reverse alphabetical order to verify sorting
    const skills = new Map([
      skill("concise", "Be concise."),
      skill("bullet-points", "Always use bullet points."),
    ]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest();

    const received: ModelRequest[] = [];
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      received.push(req);
      return DONE_RESPONSE;
    };

    await wrapModelCall(mockTurnContext(), request, next);

    expect(received).toHaveLength(1);
    // Exact order: bullet-points before concise (alphabetical)
    expect(received[0]?.systemPrompt).toBe("Always use bullet points.\n\n---\n\nBe concise.");
  });

  test("prepends skill content before existing systemPrompt", async () => {
    const skills = new Map([skill("bullet-points", "Always use bullet points.")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest("You are a helpful assistant.");

    const received: ModelRequest[] = [];
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      received.push(req);
      return DONE_RESPONSE;
    };

    await wrapModelCall(mockTurnContext(), request, next);

    expect(received).toHaveLength(1);
    const prompt = received[0]?.systemPrompt;
    expect(prompt).toBe("Always use bullet points.\n\nYou are a helpful assistant.");
  });

  test("wrapModelStream injects skills the same way", async () => {
    const skills = new Map([skill("bullet-points", "Always use bullet points.")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelStream } = assertHooks(mw);
    const request = mockRequest("Base prompt.");

    const received: ModelRequest[] = [];
    async function* mockNext(req: ModelRequest) {
      received.push(req);
      yield { kind: "text_delta" as const, delta: "hi" };
    }

    const chunks = [];
    for await (const chunk of wrapModelStream(mockTurnContext(), request, mockNext)) {
      chunks.push(chunk);
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.systemPrompt).toBe("Always use bullet points.\n\nBase prompt.");
    expect(chunks).toHaveLength(1);
  });

  test("describeCapabilities returns undefined when no skills", () => {
    const agent = mockAgent(new Map());
    const mw = createSkillInjectorMiddleware({ agent });

    expect(mw.describeCapabilities(mockTurnContext())).toBeUndefined();
  });

  test("describeCapabilities returns fragment with skill names", () => {
    const skills = new Map([skill("bullet-points", "content"), skill("concise", "content")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent });

    const cap = mw.describeCapabilities(mockTurnContext());
    expect(cap).toEqual({
      label: "skills",
      description: "2 skills active: bullet-points, concise",
    });
  });

  test("describeCapabilities uses singular for one skill", () => {
    const skills = new Map([skill("bullet-points", "content")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent });

    const cap = mw.describeCapabilities(mockTurnContext());
    expect(cap?.description).toBe("1 skill active: bullet-points");
  });

  test("accepts a thunk for lazy agent resolution", async () => {
    const skills = new Map([skill("bullet-points", "Always use bullet points.")]);
    const ref: { current: Agent | undefined } = { current: undefined };
    const mw = createSkillInjectorMiddleware({
      agent: (): Agent => {
        if (ref.current === undefined) throw new Error("Agent not yet wired");
        return ref.current;
      },
    });
    const { wrapModelCall } = assertHooks(mw);

    // Set agent after middleware creation (simulates createKoi flow)
    ref.current = mockAgent(skills);

    const received: ModelRequest[] = [];
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      received.push(req);
      return DONE_RESPONSE;
    };

    await wrapModelCall(mockTurnContext(), mockRequest(), next);

    expect(received).toHaveLength(1);
    expect(received[0]?.systemPrompt).toBe("Always use bullet points.");
  });
});
