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
  /**
   * When true: inject an `<available_skills>` XML block (name + description per
   * skill) instead of concatenated full bodies. Use with `createSkillProvider`
   * configured as `{ progressive: true }` so components have empty content.
   *
   * Default: false (inject full bodies, legacy behavior).
   */
  readonly progressive?: boolean;
  /**
   * When true: include `executionMode: "fork"` skills in the `<available_skills>`
   * XML block. Set this when the agent has a `spawnFn` wired and fork skills are
   * therefore executable via the `Skill` tool.
   *
   * Default: false — fork skills are excluded from the XML block to prevent
   * NOT_FOUND/VALIDATION errors when no `spawnFn` is configured.
   */
  readonly hasForkSupport?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SKILL_PREFIX = "skill:";
const SEPARATOR = "\n\n---\n\n";
// Matches the tool name registered by @koi/skill-tool's createSkillTool().
// Checked in the PROGRESSIVE path only: if Skill is absent from request.tools
// (e.g., ceiling-blocked in a child), skip XML injection so the model is not
// steered toward on-demand skills it cannot invoke. Eager body-backed skills
// (non-empty content) are always injected regardless of tool list.
const SKILL_TOOL_NAME = "Skill";

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
 * Collects skill names from the agent ECS for capability description.
 * In progressive mode with hasForkSupport: false, excludes fork skills to
 * match the set actually advertised in <available_skills>.
 */
function collectSkillNames(
  agent: Agent,
  progressive: boolean,
  hasForkSupport: boolean,
): readonly string[] {
  const sorted = sortedSkills(agent);
  if (progressive) {
    // Match the same filter as injectSkillsProgressive: only runtimeBacked progressive
    // skills (excludes MCP/external metadata-only stubs) and fork skills unless supported.
    return sorted
      .filter(
        (s) =>
          s.content !== "" ||
          (s.runtimeBacked === true && (hasForkSupport || s.executionMode !== "fork")),
      )
      .map((s) => s.name);
  }
  return sorted.map((s) => s.name);
}

/**
 * Returns a new ModelRequest with skill content prepended to systemPrompt.
 * Only injects skills with non-empty content (full bodies). Empty-content skills
 * (MCP metadata-only or progressive-mode components) are silently ignored here —
 * the progressive path handles those via an <available_skills> XML block.
 *
 * Graceful mismatch handling: if runtimeBacked skills are present (indicating the
 * provider was configured progressive: true) but the middleware is non-progressive,
 * inject an <available_skills> XML block for them so they are not silently dropped.
 * This prevents a misconfigured setup from making skills invisible to the model.
 *
 * Returns the original request unchanged when no skills contribute any content.
 */
function injectSkills(agent: Agent, request: ModelRequest): ModelRequest {
  // Eager path: skill bodies are embedded in systemPrompt and do NOT require
  // the Skill tool to be invoked. Always inject regardless of tool list.
  const sorted = sortedSkills(agent);
  if (sorted.length === 0) return request;

  const bodies = sorted.map((s) => s.content).filter((c) => c !== "");
  // Fallback for provider/middleware progressive mismatch: include runtimeBacked
  // skills via XML block so they are not silently dropped.
  // Fork skills are excluded (no hasForkSupport in legacy path = safe default):
  // without spawnFn the Skill tool would VALIDATION-error on fork execution.
  const runtimeBackedSkills = sorted.filter(
    (s) => s.runtimeBacked === true && s.executionMode !== "fork",
  );

  if (bodies.length === 0 && runtimeBackedSkills.length === 0) return request;

  const parts: string[] = [];
  if (runtimeBackedSkills.length > 0) parts.push(generateAvailableSkillsBlock(runtimeBackedSkills));
  if (bodies.length > 0) parts.push(bodies.join(SEPARATOR));
  const content = parts.join("\n\n");

  const existing = request.systemPrompt;
  const systemPrompt =
    existing !== undefined && existing.length > 0 ? `${content}\n\n${existing}` : content;

  return { ...request, systemPrompt };
}

/** Max chars of systemPrompt to include in decision metadata. */
const PROMPT_PREVIEW_LIMIT = 800;

/** Escapes XML attribute special chars in a skill name or description. */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Renders the <available_skills> XML block from skill metadata.
 * One self-closing <skill> element per skill, sorted alphabetically.
 * Prompt-cache-stable: same sort order as sortedSkills().
 */
function generateAvailableSkillsBlock(skills: readonly SkillComponent[]): string {
  const items = skills
    .map(
      (s) =>
        `  <skill name="${escapeXmlAttr(s.name)}" description="${escapeXmlAttr(s.description)}" />`,
    )
    .join("\n");
  return `<available_skills>\n${items}\n</available_skills>`;
}

/**
 * Build the decision payload for skill injection.
 * Captures skill names, per-skill content length, and a preview of
 * the final systemPrompt so the trajectory shows what was actually injected.
 * When progressive mode excludes fork skills (hasForkSupport: false), their
 * names appear in `excludedForkSkills` so operators can detect misconfiguration
 * without needing to diff before/after skill lists.
 */
function buildDecision(
  agent: Agent,
  systemPrompt: string | undefined,
  progressive: boolean,
  hasForkSupport: boolean,
): JsonObject {
  const sorted = sortedSkills(agent);
  const excludedForkSkills =
    progressive && !hasForkSupport
      ? sorted
          .filter((s) => s.runtimeBacked === true && s.executionMode === "fork")
          .map((s) => s.name)
      : [];
  return {
    injected: sorted.length > 0,
    skillCount: sorted.length,
    skills: sorted.map((s) => ({ name: s.name, contentLength: s.content.length })),
    ...(excludedForkSkills.length > 0 ? { excludedForkSkills } : {}),
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

/**
 * Returns a new ModelRequest with an <available_skills> XML block prepended
 * to systemPrompt. Contains name + description for each skill (no bodies).
 * If no skills are attached, returns the original request unchanged.
 */
function injectSkillsProgressive(
  agent: Agent,
  request: ModelRequest,
  hasForkSupport: boolean,
): ModelRequest {
  const sorted = sortedSkills(agent);
  // Gate only the <available_skills> XML block on Skill tool presence.
  // Body-backed (non-runtime) skills are always injected — they don't require
  // the Skill tool; their guidance is embedded directly in systemPrompt.
  const skillToolPresent =
    request.tools === undefined || request.tools.some((t) => t.name === SKILL_TOOL_NAME);
  // Runtime-backed progressive skills have runtimeBacked: true (set by attachProgressive).
  // MCP/external metadata-only stubs lack this marker and are excluded from the XML block
  // to prevent Skill() calls that would return empty bodies with no useful guidance.
  // Fork skills are excluded unless hasForkSupport: true (spawnFn wired).
  const runtimeSkills = skillToolPresent
    ? sorted.filter(
        (s) => s.runtimeBacked === true && (hasForkSupport || s.executionMode !== "fork"),
      )
    : [];
  // Non-runtime skills (browser, memory, etc.) carry non-empty bodies.
  // Inject them via the legacy path so their guidance still reaches the model.
  const otherBodies = sorted.map((s) => s.content).filter((c) => c !== "");

  if (runtimeSkills.length === 0 && otherBodies.length === 0) return request;

  const parts: string[] = [];
  if (runtimeSkills.length > 0) parts.push(generateAvailableSkillsBlock(runtimeSkills));
  if (otherBodies.length > 0) parts.push(otherBodies.join(SEPARATOR));
  const injected = parts.join("\n\n");

  const existing = request.systemPrompt;
  const systemPrompt =
    existing !== undefined && existing.length > 0 ? `${injected}\n\n${existing}` : injected;
  return { ...request, systemPrompt };
}

/**
 * Returns true when progressive mode has excluded fork skills but injected nothing,
 * so `injected === request`. Without this guard, `reportDecision` would be skipped
 * and `excludedForkSkills` would never surface in the ATIF trajectory — making the
 * hasForkSupport misconfiguration invisible to operators.
 */
function shouldReportExclusions(
  agent: Agent,
  progressive: boolean,
  hasForkSupport: boolean,
): boolean {
  if (!progressive || hasForkSupport) return false;
  const sorted = sortedSkills(agent);
  return sorted.some((s) => s.runtimeBacked === true && s.executionMode === "fork");
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
  const { agent: agentOrFn, progressive = false, hasForkSupport = false } = config;

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
      const injected = progressive
        ? injectSkillsProgressive(agent, request, hasForkSupport)
        : injectSkills(agent, request);
      // Always report when skills changed OR when progressive mode has excluded fork
      // skills (injected === request but exclusion metadata should still be visible).
      if (injected !== request || shouldReportExclusions(agent, progressive, hasForkSupport)) {
        ctx.reportDecision?.(
          buildDecision(agent, injected.systemPrompt, progressive, hasForkSupport),
        );
      }
      return next(injected);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const agent = resolveAgent(agentOrFn);
      const injected = progressive
        ? injectSkillsProgressive(agent, request, hasForkSupport)
        : injectSkills(agent, request);
      if (injected !== request || shouldReportExclusions(agent, progressive, hasForkSupport)) {
        ctx.reportDecision?.(
          buildDecision(agent, injected.systemPrompt, progressive, hasForkSupport),
        );
      }
      yield* next(injected);
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      const names = collectSkillNames(resolveAgent(agentOrFn), progressive, hasForkSupport);
      if (names.length === 0) return undefined;
      return {
        label: "skills",
        description: `${String(names.length)} skill${names.length === 1 ? "" : "s"} active: ${names.join(", ")}`,
      };
    },
  };
}
