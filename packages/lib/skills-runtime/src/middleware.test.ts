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

function progressiveSkill(
  name: string,
  opts?: Partial<SkillComponent>,
): [SubsystemToken<SkillComponent>, SkillComponent] {
  const token = `skill:${name}` as SubsystemToken<SkillComponent>;
  return [token, { name, description: `${name} skill`, content: "", runtimeBacked: true, ...opts }];
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

describe("createSkillInjectorMiddleware — progressive mode", () => {
  test("injects <available_skills> XML block when skills have empty content", async () => {
    // In progressive mode, provider sets content: "" and runtimeBacked: true
    const skills = new Map([progressiveSkill("commit"), progressiveSkill("review")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent, progressive: true });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest();

    const received: ModelRequest[] = [];
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      received.push(req);
      return DONE_RESPONSE;
    };

    await wrapModelCall(mockTurnContext(), request, next);

    expect(received).toHaveLength(1);
    const prompt = received[0]?.systemPrompt ?? "";
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain('name="commit"');
    expect(prompt).toContain('name="review"');
    expect(prompt).toContain("</available_skills>");
    expect(prompt).not.toContain("---");
  });

  test("progressive XML block is sorted alphabetically for cache stability", async () => {
    const skills = new Map([progressiveSkill("zebra"), progressiveSkill("alpha")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent, progressive: true });
    const { wrapModelCall } = assertHooks(mw);

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), mockRequest(), async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    const prompt = received[0]?.systemPrompt ?? "";
    const alphaPos = prompt.indexOf('name="alpha"');
    const zebraPos = prompt.indexOf('name="zebra"');
    expect(alphaPos).toBeLessThan(zebraPos);
  });

  test("progressive XML block tokens << eager bodies tokens (regression)", async () => {
    const bigBody = "A".repeat(3000);
    const eagerSkills = new Map(
      Array.from({ length: 10 }, (_, i) => skill(`skill-${String(i)}`, bigBody)),
    );
    const progressiveSkills = new Map(
      Array.from({ length: 10 }, (_, i) => progressiveSkill(`skill-${String(i)}`)),
    );

    const eagerAgent = mockAgent(eagerSkills);
    const progressiveAgent = mockAgent(progressiveSkills);

    const eagerMw = createSkillInjectorMiddleware({ agent: eagerAgent });
    const progressiveMw = createSkillInjectorMiddleware({
      agent: progressiveAgent,
      progressive: true,
    });
    const { wrapModelCall: eagerCall } = assertHooks(eagerMw);
    const { wrapModelCall: progressiveCall } = assertHooks(progressiveMw);

    const eagerReceived: ModelRequest[] = [];
    const progressiveReceived: ModelRequest[] = [];

    await eagerCall(mockTurnContext(), mockRequest(), async (req) => {
      eagerReceived.push(req);
      return DONE_RESPONSE;
    });
    await progressiveCall(mockTurnContext(), mockRequest(), async (req) => {
      progressiveReceived.push(req);
      return DONE_RESPONSE;
    });

    const eagerLen = eagerReceived[0]?.systemPrompt?.length ?? 0;
    const progressiveLen = progressiveReceived[0]?.systemPrompt?.length ?? 0;

    expect(progressiveLen).toBeLessThan(eagerLen / 10);
    expect(eagerLen).toBeGreaterThan(25000);
  });

  test("progressive passes through unchanged when no skills", async () => {
    const agent = mockAgent(new Map());
    const mw = createSkillInjectorMiddleware({ agent, progressive: true });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest("existing prompt");

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), request, async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    expect(received[0]).toBe(request);
  });

  test("progressive XML block prepended before existing systemPrompt", async () => {
    const skills = new Map([progressiveSkill("commit")]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent, progressive: true });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest("You are a helpful assistant.");

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), request, async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    const prompt = received[0]?.systemPrompt ?? "";
    expect(prompt).toMatch(/^<available_skills>/);
    expect(prompt).toContain("You are a helpful assistant.");
  });

  test("non-progressive middleware injects XML fallback for runtimeBacked skills (provider/middleware mismatch)", async () => {
    // When the provider is progressive (runtimeBacked: true, content: "") but the middleware
    // is non-progressive (progressive: false / default), runtimeBacked skills must NOT be
    // silently dropped — the middleware injects an <available_skills> XML block as a fallback.
    const skills = new Map([progressiveSkill("commit"), progressiveSkill("review")]);
    const agent = mockAgent(skills);
    // Middleware is non-progressive (default) but skills have runtimeBacked: true
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);
    const request = mockRequest();

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), request, async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    const prompt = received[0]?.systemPrompt ?? "";
    // Should inject XML block rather than silently dropping the skills
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain('name="commit"');
    expect(prompt).toContain('name="review"');
  });

  test("non-progressive middleware fallback excludes fork skills (no spawnFn = VALIDATION risk)", async () => {
    // In the legacy fallback path, runtimeBacked fork skills must NOT appear in the XML
    // block because there is no hasForkSupport=true and no spawnFn — the Skill tool would
    // VALIDATION-error if the model invokes a fork skill.
    const skills = new Map([
      progressiveSkill("normal-skill"),
      progressiveSkill("fork-skill", { executionMode: "fork" }),
    ]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent }); // non-progressive, no hasForkSupport
    const { wrapModelCall } = assertHooks(mw);

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), mockRequest(), async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    const prompt = received[0]?.systemPrompt ?? "";
    expect(prompt).toContain('name="normal-skill"');
    // Fork skill must NOT appear — no spawn support in non-progressive middleware
    expect(prompt).not.toContain('name="fork-skill"');
  });

  test("progressive mode reports excludedForkSkills telemetry even when all skills are filtered", async () => {
    // When progressive mode has only fork skills and hasForkSupport is false,
    // injectSkillsProgressive returns the original request unchanged.
    // reportDecision must still fire so excludedForkSkills is visible to operators.
    const skills = new Map([progressiveSkill("fork-only", { executionMode: "fork" })]);
    const agent = mockAgent(skills);
    const mw = createSkillInjectorMiddleware({ agent, progressive: true }); // hasForkSupport defaults false
    const { wrapModelCall } = assertHooks(mw);

    const decisions: unknown[] = [];
    const ctx = {
      ...mockTurnContext(),
      reportDecision: (d: unknown) => {
        decisions.push(d);
      },
    };

    await wrapModelCall(ctx, mockRequest(), async (req) => req as never);

    // Decision must be reported even though the request was unchanged
    expect(decisions).toHaveLength(1);
    const decision = decisions[0] as Record<string, unknown>;
    expect(Array.isArray(decision.excludedForkSkills)).toBe(true);
    expect((decision.excludedForkSkills as string[]).includes("fork-only")).toBe(true);
  });
});

describe("createSkillInjectorMiddleware — Skill tool gate", () => {
  // Regression for #1986: child agents with a tool ceiling that excludes
  // the Skill tool must not receive <available_skills> injection, otherwise
  // the model is steered toward skills it cannot invoke.

  function mockRequestWithTools(toolNames: readonly string[]): ModelRequest {
    return {
      messages: [],
      tools: toolNames.map((name) => ({
        name,
        description: `${name} tool`,
        inputSchema: { type: "object" as const, properties: {} },
      })),
    };
  }

  test("eager mode: injects skills regardless of Skill tool presence in tools list", async () => {
    // Eager body-backed skills do not require the Skill tool — the body is embedded
    // directly in systemPrompt. Gate applies only to the progressive XML block.
    const agent = mockAgent(new Map([skill("guide", "## Guide")]));
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), mockRequestWithTools(["Bash", "Read"]), async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    // Skill tool absent but eager body still injected — no gate on eager path
    expect(received[0]?.systemPrompt).toContain("## Guide");
  });

  test("injects skills when Skill tool present in explicit tools list", async () => {
    const agent = mockAgent(new Map([skill("guide", "## Guide")]));
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), mockRequestWithTools(["Bash", "Skill"]), async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    expect(received[0]?.systemPrompt).toContain("## Guide");
  });

  test("injects skills when tools is undefined (no engine tool filtering)", async () => {
    const agent = mockAgent(new Map([skill("guide", "## Guide")]));
    const mw = createSkillInjectorMiddleware({ agent });
    const { wrapModelCall } = assertHooks(mw);

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), mockRequest(), async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    // Undefined tools → no engine filtering → allow injection
    expect(received[0]?.systemPrompt).toContain("## Guide");
  });

  test("progressive mode: skips XML block when Skill tool absent", async () => {
    const agent = mockAgent(new Map([progressiveSkill("cmd")]));
    const mw = createSkillInjectorMiddleware({ agent, progressive: true });
    const { wrapModelCall } = assertHooks(mw);

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), mockRequestWithTools(["Bash"]), async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    expect(received[0]?.systemPrompt).toBeUndefined();
  });

  test("progressive mode: body-backed skills inject even when Skill tool absent", async () => {
    // Non-runtime (body-backed) skills in a progressive-mode session still
    // need their guidance in systemPrompt even when the Skill tool is filtered
    // out (e.g., by a child-agent tool ceiling). The gate only applies to the
    // <available_skills> XML block for runtimeBacked skills.
    const agent = mockAgent(
      new Map([progressiveSkill("cmd"), skill("browser", "## Browser guidance")]),
    );
    const mw = createSkillInjectorMiddleware({ agent, progressive: true });
    const { wrapModelCall } = assertHooks(mw);

    const received: ModelRequest[] = [];
    await wrapModelCall(mockTurnContext(), mockRequestWithTools(["Bash"]), async (req) => {
      received.push(req);
      return DONE_RESPONSE;
    });

    // Body-backed "browser" skill injected; runtimeBacked "cmd" XML block skipped
    expect(received[0]?.systemPrompt).toContain("## Browser guidance");
    expect(received[0]?.systemPrompt).not.toContain("<available_skills>");
  });
});
