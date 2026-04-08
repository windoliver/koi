/**
 * Skill injection middleware — reads SkillComponent entries from the agent ECS
 * and prepends their content into the model's systemPrompt.
 *
 * Phase: "resolve" (priority 300). Skills are business logic, not permissions.
 */

import type {
  Agent,
  CapabilityFragment,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SkillComponent,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SkillInjectorConfig {
  /**
   * Agent entity accessor. Called at each model call to query skill components.
   *
   * Use a thunk because the middleware is created before `createKoi` assembles
   * the agent entity. The caller wires the accessor after assembly:
   *
   * ```ts
   * const ref: { current?: Agent } = {};
   * const mw = createSkillInjectorMiddleware({ agent: () => ref.current! });
   * const runtime = await createKoi({ middleware: [mw], providers: [provider] });
   * ref.current = runtime.agent;
   * ```
   *
   * Or pass a direct reference when the agent is already assembled.
   */
  readonly agent: Agent | (() => Agent);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SKILL_PREFIX = "skill:";
const SEPARATOR = "\n\n---\n\n";

function resolveAgent(agentOrFn: Agent | (() => Agent)): Agent {
  return typeof agentOrFn === "function" ? agentOrFn() : agentOrFn;
}

/**
 * Returns all skill components sorted by name for deterministic output.
 * Map iteration order depends on insertion order (Bun.Glob scan order),
 * which is nondeterministic across machines. Sorting by name ensures
 * stable systemPrompt text and prompt-cache hits.
 */
function sortedSkills(agent: Agent): readonly SkillComponent[] {
  const skills = agent.query<SkillComponent>(SKILL_PREFIX);
  if (skills.size === 0) return [];
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Queries the agent ECS for all attached SkillComponent entries and returns
 * their content joined with a separator. Returns undefined when no skills
 * are attached (callers should passthrough without modification).
 */
function collectSkillContent(agent: Agent): string | undefined {
  const sorted = sortedSkills(agent);
  if (sorted.length === 0) return undefined;
  return sorted.map((s) => s.content).join(SEPARATOR);
}

/**
 * Collects skill names from the agent ECS for capability description.
 */
function collectSkillNames(agent: Agent): readonly string[] {
  return sortedSkills(agent).map((s) => s.name);
}

/**
 * Returns a new ModelRequest with skill content prepended to systemPrompt.
 * If no skills are attached, returns the original request unchanged.
 */
function injectSkills(agent: Agent, request: ModelRequest): ModelRequest {
  const content = collectSkillContent(agent);
  if (content === undefined) return request;

  const existing = request.systemPrompt;
  const systemPrompt =
    existing !== undefined && existing.length > 0 ? `${content}\n\n${existing}` : content;

  return { ...request, systemPrompt };
}

/** Max chars of systemPrompt to include in decision metadata. */
const PROMPT_PREVIEW_LIMIT = 800;

/**
 * Build the decision payload for skill injection.
 * Captures skill names, per-skill content length, and a preview of
 * the final systemPrompt so the trajectory shows what was actually injected.
 */
function buildDecision(agent: Agent, systemPrompt: string | undefined): JsonObject {
  const sorted = sortedSkills(agent);
  return {
    injected: sorted.length > 0,
    skillCount: sorted.length,
    skills: sorted.map((s) => ({ name: s.name, contentLength: s.content.length })),
    ...(systemPrompt !== undefined
      ? {
          systemPrompt:
            systemPrompt.length <= PROMPT_PREVIEW_LIMIT
              ? systemPrompt
              : `${systemPrompt.slice(0, PROMPT_PREVIEW_LIMIT)}… (${String(systemPrompt.length)} chars)`,
        }
      : {}),
  } as JsonObject;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a middleware that injects skill content into the model's system prompt.
 *
 * Queries `agent.query<SkillComponent>("skill:")` at each model call and prepends
 * all attached skill content into `request.systemPrompt`. Passthrough when no
 * skills are attached.
 *
 * Accepts either a direct Agent reference or a thunk `() => Agent` for lazy
 * resolution (needed when the middleware is created before `createKoi` assembles
 * the agent entity).
 */
export function createSkillInjectorMiddleware(config: SkillInjectorConfig): KoiMiddleware {
  const { agent: agentOrFn } = config;

  return {
    name: "skill-injector",
    phase: "resolve" as const,
    priority: 300,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const agent = resolveAgent(agentOrFn);
      const injected = injectSkills(agent, request);
      ctx.reportDecision?.(buildDecision(agent, injected.systemPrompt));
      return next(injected);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const agent = resolveAgent(agentOrFn);
      const injected = injectSkills(agent, request);
      ctx.reportDecision?.(buildDecision(agent, injected.systemPrompt));
      yield* next(injected);
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      const names = collectSkillNames(resolveAgent(agentOrFn));
      if (names.length === 0) return undefined;
      return {
        label: "skills",
        description: `${String(names.length)} skill${names.length === 1 ? "" : "s"} active: ${names.join(", ")}`,
      };
    },
  };
}
