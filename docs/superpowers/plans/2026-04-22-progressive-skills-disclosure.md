# Progressive Skills Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `@koi/skills-runtime` from eager-loading all skill bodies into `systemPrompt` to a two-phase model: inject only frontmatter metadata at session start, load full bodies on demand via the existing `Skill` tool.

**Architecture:** Add `progressive?: boolean` to both `createSkillProvider` config (skips `loadAll()`, creates empty-content components) and `createSkillInjectorMiddleware` config (renders an `<available_skills>` XML block from descriptions instead of concatenated bodies). Both default to `false` for backward compatibility. The existing `@koi/skill-tool` already handles on-demand body loading — no changes needed there.

**Tech Stack:** TypeScript 6, `bun:test`, `@koi/core` (SkillComponent, skillToken), `@koi/skills-runtime` (SkillsRuntime, provider, middleware)

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `packages/lib/skills-runtime/src/provider.ts` | Modify | Add `SkillProviderConfig` type; add progressive branch that calls `discover()` instead of `loadAll()` and sets `content: ""` |
| `packages/lib/skills-runtime/src/middleware.ts` | Modify | Add `progressive?: boolean` to `SkillInjectorConfig`; add `generateAvailableSkillsBlock()` helper; add progressive inject path |
| `packages/lib/skills-runtime/src/provider.test.ts` | Modify | Add `describe("progressive mode")` block with 4 tests |
| `packages/lib/skills-runtime/src/middleware.test.ts` | Modify | Add `describe("progressive mode")` block with 5 tests including token-count regression |
| `docs/L2/skills-runtime.md` | Modify | Add "Progressive Mode" section documenting the two-phase API |

---

### Task 1: Update docs (doc-gate requirement — must come first)

**Files:**
- Modify: `docs/L2/skills-runtime.md`

- [ ] **Step 1: Open the doc and find the insertion point**

The file currently has a `## Architecture` section near the top. Add a new `## Progressive Mode` section after the existing `## Configuration` section (search for `## Configuration` to find the location).

- [ ] **Step 2: Add the Progressive Mode section**

Find the line `## Configuration` in `docs/L2/skills-runtime.md` and add the following section immediately after the closing of that section (before the next `##` heading, or at end of file if there is none after Configuration):

```markdown
## Progressive Mode

By default the provider eagerly loads every skill body into `systemPrompt` at session start.
Enable progressive mode to defer body loading until the model explicitly invokes the `Skill` tool.

### Phase 1 — Discovery (session start, ~100 tokens)

```typescript
import { createSkillProvider, createSkillInjectorMiddleware } from "@koi/skills-runtime";
import { createSkillTool } from "@koi/skill-tool";

const ref: { current?: Agent } = {};
const mw = createSkillInjectorMiddleware({ agent: () => ref.current!, progressive: true });
const provider = createSkillProvider(runtime, { progressive: true });
const skillTool = await createSkillTool({ resolver: runtime, signal: new AbortController().signal });

const koi = await createKoi({ providers: [provider], middleware: [mw], tools: [skillTool.value] });
ref.current = koi.agent;
```

The middleware injects an `<available_skills>` XML block into `systemPrompt` instead of concatenated bodies:

```xml
<available_skills>
  <skill name="commit" description="Generate a conventional commit message from staged changes." />
  <skill name="review" description="Review a pull request for correctness and style." />
</available_skills>
```

### Phase 2 — Invocation (on-demand, ~2–5K tokens per skill)

The model calls `Skill({ skill: "commit" })`. The `@koi/skill-tool` handler calls `runtime.load("commit")`,
returns the full body as a tool result, and the LRU cache (bounded by `cacheMaxBodies`) serves
subsequent invocations without a disk read.

### Token savings

| Setup | 10 skills × 3K body | 10 skills (progressive) |
|-------|--------------------|-----------------------|
| systemPrompt tokens | ~30K | ~100 |
| Cost per turn | 30K × N turns | 100 × N turns |
| Body load cost | 0 (paid upfront) | 3K when Skill() called |

### Backward compatibility

Both `progressive` flags default to `false`. Existing callers that omit the flag continue to use
the eager path unchanged.
```

- [ ] **Step 3: Commit doc update**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
git add docs/L2/skills-runtime.md
git commit -m "docs(skills-runtime): document progressive disclosure mode (#1986)"
```

---

### Task 2: Write failing tests for progressive provider

**Files:**
- Modify: `packages/lib/skills-runtime/src/provider.test.ts`

- [ ] **Step 1: Add the failing test block**

Append the following `describe` block at the end of `packages/lib/skills-runtime/src/provider.test.ts` (after the existing `describe("skillDefinitionToComponent", ...)` block, before the final EOF):

```typescript
describe("createSkillProvider — progressive mode", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-provider-prog-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("progressive: true attaches skills with empty content (no body loaded)", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const token = skillToken("my-skill");
    const component = result.components.get(token) as { name: string; description: string; content: string } | undefined;
    expect(component).toBeDefined();
    expect(component?.name).toBe("my-skill");
    expect(component?.description).toBe("Test my-skill.");
    expect(component?.content).toBe("");
  });

  test("progressive: true does not load bodies even for multiple skills", async () => {
    await writeSkill(userRoot, "skill-a", "Long body A.");
    await writeSkill(userRoot, "skill-b", "Long body B.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const a = result.components.get(skillToken("skill-a")) as { content: string } | undefined;
    const b = result.components.get(skillToken("skill-b")) as { content: string } | undefined;
    expect(a?.content).toBe("");
    expect(b?.content).toBe("");
  });

  test("progressive: true preserves description for XML rendering", async () => {
    await Bun.write(
      join(userRoot, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Does cool things.\n---\n\nBody.",
      { createPath: true },
    );
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("my-skill")) as { description: string } | undefined;
    expect(component?.description).toBe("Does cool things.");
  });

  test("progressive: false (explicit) uses eager path — content is non-empty", async () => {
    await writeSkill(userRoot, "eager-skill", "Eager body.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: false });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("eager-skill")) as { content: string } | undefined;
    expect(component?.content).toContain("Eager body.");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run test --filter=@koi/skills-runtime 2>&1 | grep -E "fail|pass|createSkillProvider — progressive"
```

Expected: tests in `createSkillProvider — progressive mode` fail with "createSkillProvider is not a function with 2 args" or type error.

---

### Task 3: Implement progressive provider

**Files:**
- Modify: `packages/lib/skills-runtime/src/provider.ts`

- [ ] **Step 1: Add `SkillProviderConfig` and update `createSkillProvider` signature**

In `packages/lib/skills-runtime/src/provider.ts`, add the config type and refactor the function. Replace the entire file content with:

```typescript
/**
 * createSkillProvider — ComponentProvider bridge from SkillsRuntime to the agent ECS.
 *
 * This is the L3 hook: it takes a SkillsRuntime, discovers/loads skills,
 * and attaches them to an Agent as SkillComponent instances under skillToken(name) keys.
 * The engine middleware then surfaces them to the model via describeCapabilities().
 *
 * Skipped skills (NOT_FOUND, VALIDATION, PERMISSION) are reported as SkippedComponent
 * entries rather than throwing — partial success is the right behavior.
 */

import type {
  Agent,
  AttachResult,
  BrickRequires,
  ComponentProvider,
  SkillComponent,
} from "@koi/core";
import { COMPONENT_PRIORITY, skillToken } from "@koi/core";
import type { SkillDefinition, SkillMetadata, SkillsRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SkillProviderConfig {
  /**
   * When true: call discover() only, attaching SkillComponents with empty
   * content. The middleware injects an <available_skills> block from
   * descriptions; full bodies load on demand via the Skill tool.
   *
   * When false (default): call loadAll() to eagerly load all bodies and
   * inject them into systemPrompt at every model call.
   */
  readonly progressive?: boolean;
}

/**
 * Creates a ComponentProvider that bridges a SkillsRuntime to the agent ECS.
 *
 * Eager mode (default, progressive: false):
 *   Calls runtime.loadAll(), converts each SkillDefinition → SkillComponent
 *   with full body in content.
 *
 * Progressive mode (progressive: true):
 *   Calls runtime.discover(), creates SkillComponents with content: "" so
 *   the injector middleware renders an <available_skills> XML summary block.
 *
 * Compatible with Nexus in the future: swap the runtime implementation,
 * keep the same provider.
 */
export function createSkillProvider(
  runtime: SkillsRuntime,
  config?: SkillProviderConfig,
): ComponentProvider {
  const progressive = config?.progressive ?? false;
  return {
    name: "skills-runtime",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<AttachResult> =>
      progressive ? attachProgressive(runtime) : attachEager(runtime),
  };
}

// ---------------------------------------------------------------------------
// Attach strategies
// ---------------------------------------------------------------------------

async function attachEager(runtime: SkillsRuntime): Promise<AttachResult> {
  const allResult = await runtime.loadAll();
  const components = new Map<string, unknown>();
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

  if (!allResult.ok) {
    skipped.push({ name: "__discover__", reason: allResult.error.message });
    return { components: components as ReadonlyMap<string, unknown>, skipped };
  }

  for (const [name, result] of allResult.value) {
    if (!result.ok) {
      skipped.push({ name, reason: result.error.message });
      continue;
    }
    components.set(skillToken(name), skillDefinitionToComponent(result.value));
  }

  return { components: components as ReadonlyMap<string, unknown>, skipped };
}

async function attachProgressive(runtime: SkillsRuntime): Promise<AttachResult> {
  const discoverResult = await runtime.discover();
  const components = new Map<string, unknown>();
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

  if (!discoverResult.ok) {
    skipped.push({ name: "__discover__", reason: discoverResult.error.message });
    return { components: components as ReadonlyMap<string, unknown>, skipped };
  }

  for (const [name, metadata] of discoverResult.value) {
    components.set(skillToken(name), skillMetadataToComponent(metadata));
  }

  return { components: components as ReadonlyMap<string, unknown>, skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a SkillDefinition to a SkillComponent (for consumers that already
 * have a loaded definition and want to attach it directly).
 */
export function skillDefinitionToComponent(skill: SkillDefinition): SkillComponent {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.body,
    ...(skill.requires !== undefined ? { requires: skill.requires as BrickRequires } : {}),
    ...(skill.executionMode !== undefined ? { executionMode: skill.executionMode } : {}),
  };
}

/**
 * Converts SkillMetadata to a SkillComponent with empty content.
 * Used in progressive mode — body is loaded on demand via the Skill tool.
 */
function skillMetadataToComponent(metadata: SkillMetadata): SkillComponent {
  return {
    name: metadata.name,
    description: metadata.description,
    content: "",
    ...(metadata.allowedTools !== undefined ? { tags: metadata.allowedTools } : {}),
    ...(metadata.requires !== undefined ? { requires: metadata.requires as BrickRequires } : {}),
    ...(metadata.executionMode !== undefined ? { executionMode: metadata.executionMode } : {}),
  };
}
```

- [ ] **Step 2: Run provider tests — all should pass**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run test --filter=@koi/skills-runtime 2>&1 | grep -E "pass|fail|provider"
```

Expected: All provider tests pass including the 4 new progressive ones.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run typecheck --filter=@koi/skills-runtime 2>&1 | tail -10
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
git add packages/lib/skills-runtime/src/provider.ts packages/lib/skills-runtime/src/provider.test.ts
git commit -m "feat(skills-runtime): add progressive mode to createSkillProvider (#1986)"
```

---

### Task 4: Write failing tests for progressive middleware

**Files:**
- Modify: `packages/lib/skills-runtime/src/middleware.test.ts`

- [ ] **Step 1: Add the failing test block**

The existing `middleware.test.ts` already defines `mockAgent`, `skill()`, `mockTurnContext`, `mockRequest`, and `assertHooks`. Append the following `describe` block at the end of the file (after the closing `});` of the existing `describe("createSkillInjectorMiddleware", ...)`):

```typescript
describe("createSkillInjectorMiddleware — progressive mode", () => {
  test("injects <available_skills> XML block when skills have empty content", async () => {
    // In progressive mode, provider sets content: "" on all components
    const skills = new Map([
      skill("commit", ""),   // empty content simulates progressive attach
      skill("review", ""),
    ]);
    const agent = mockAgent(skills);
    // Manually patch descriptions — skill() helper sets description to `${name} skill`
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
    // Must NOT contain raw body content
    expect(prompt).not.toContain("---");
  });

  test("progressive XML block is sorted alphabetically for cache stability", async () => {
    const skills = new Map([
      skill("zebra", ""),
      skill("alpha", ""),
    ]);
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
    // 10 skills each with a 3000-char body — simulates real-world token cost
    const bigBody = "A".repeat(3000);
    const eagerSkills = new Map(
      Array.from({ length: 10 }, (_, i) => skill(`skill-${String(i)}`, bigBody)),
    );
    const progressiveSkills = new Map(
      Array.from({ length: 10 }, (_, i) => skill(`skill-${String(i)}`, "")),
    );

    const eagerAgent = mockAgent(eagerSkills);
    const progressiveAgent = mockAgent(progressiveSkills);

    const eagerMw = createSkillInjectorMiddleware({ agent: eagerAgent });
    const progressiveMw = createSkillInjectorMiddleware({ agent: progressiveAgent, progressive: true });
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

    // Progressive must be at least 10× smaller than eager
    expect(progressiveLen).toBeLessThan(eagerLen / 10);
    // Eager should contain the big bodies
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

    expect(received[0]).toBe(request); // Same reference — no modification
  });

  test("progressive XML block prepended before existing systemPrompt", async () => {
    const skills = new Map([skill("commit", "")]);
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
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run test --filter=@koi/skills-runtime 2>&1 | grep -E "fail|progressive mode"
```

Expected: The 5 new middleware progressive tests fail.

---

### Task 5: Implement progressive middleware

**Files:**
- Modify: `packages/lib/skills-runtime/src/middleware.ts`

- [ ] **Step 1: Add `progressive` to `SkillInjectorConfig`**

In `packages/lib/skills-runtime/src/middleware.ts`, find the `SkillInjectorConfig` interface (line 26) and add the `progressive` field:

Replace:
```typescript
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
```

With:
```typescript
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
}
```

- [ ] **Step 2: Add the XML helper functions**

In `middleware.ts`, after the existing `const PROMPT_PREVIEW_LIMIT = 800;` constant (around line 105), add:

```typescript
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
    .map((s) => `  <skill name="${escapeXmlAttr(s.name)}" description="${escapeXmlAttr(s.description)}" />`)
    .join("\n");
  return `<available_skills>\n${items}\n</available_skills>`;
}
```

- [ ] **Step 3: Add progressive inject path and wire into factory**

In `middleware.ts`, after the existing `injectSkills` function (ends around line 102), add the progressive variant:

```typescript
/**
 * Returns a new ModelRequest with an <available_skills> XML block prepended
 * to systemPrompt. Contains name + description for each skill (no bodies).
 * If no skills are attached, returns the original request unchanged.
 */
function injectSkillsProgressive(agent: Agent, request: ModelRequest): ModelRequest {
  const sorted = sortedSkills(agent);
  if (sorted.length === 0) return request;

  const block = generateAvailableSkillsBlock(sorted);
  const existing = request.systemPrompt;
  const systemPrompt =
    existing !== undefined && existing.length > 0 ? `${block}\n\n${existing}` : block;
  return { ...request, systemPrompt };
}
```

Then update `createSkillInjectorMiddleware` to use the config's `progressive` flag. Replace the body of the factory function:

```typescript
export function createSkillInjectorMiddleware(config: SkillInjectorConfig): KoiMiddleware {
  const { agent: agentOrFn, progressive = false } = config;

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
        ? injectSkillsProgressive(agent, request)
        : injectSkills(agent, request);
      if (injected !== request) {
        ctx.reportDecision?.(buildDecision(agent, injected.systemPrompt));
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
        ? injectSkillsProgressive(agent, request)
        : injectSkills(agent, request);
      if (injected !== request) {
        ctx.reportDecision?.(buildDecision(agent, injected.systemPrompt));
      }
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
```

- [ ] **Step 4: Run all skills-runtime tests — all must pass**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run test --filter=@koi/skills-runtime 2>&1 | tail -10
```

Expected: All pass, 0 fail.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run typecheck --filter=@koi/skills-runtime 2>&1 | tail -10
```

Expected: No errors.

- [ ] **Step 6: Run lint**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run lint --filter=@koi/skills-runtime 2>&1 | tail -10
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
git add packages/lib/skills-runtime/src/middleware.ts packages/lib/skills-runtime/src/middleware.test.ts
git commit -m "feat(skills-runtime): add progressive mode to createSkillInjectorMiddleware (#1986)"
```

---

### Task 6: Full CI gate verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite for affected packages**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run test --filter=@koi/skills-runtime --filter=@koi/skill-tool 2>&1 | tail -15
```

Expected: All tests pass, 0 failures.

- [ ] **Step 2: Run layer check**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run check:layers 2>&1 | tail -10
```

Expected: No violations.

- [ ] **Step 3: Run unused exports check**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
bun run check:unused 2>&1 | tail -10
```

Expected: `SkillProviderConfig` is exported and used — should be clean. If `SkillProviderConfig` appears as unused, ensure it is exported from the package's public entry point. Check `packages/lib/skills-runtime/src/index.ts` and add `export type { SkillProviderConfig } from "./provider.js";` if missing.

- [ ] **Step 4: Final commit if index.ts needed updating**

If step 3 required adding an export to `index.ts`:

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat-1986-progressive-skills
git add packages/lib/skills-runtime/src/index.ts
git commit -m "chore(skills-runtime): export SkillProviderConfig from public API (#1986)"
```

---

## Self-Review

### Spec coverage

| Requirement (from issue #1986) | Task |
|-------------------------------|------|
| `createSkillProvider({ progressive: true })` attaches without reading bodies | Task 3 |
| Middleware injects `<available_skills>` XML block when progressive | Task 5 |
| Built-in Skill tool loads body on demand (existing `@koi/skill-tool`) | No change needed — already works |
| Regression test: progressive tokens ≪ eager tokens | Task 4 (token regression test) |
| Golden-query test for `Skill` invocation | **NOT in scope** — requires real LLM session recording; tracked separately |
| Docs updated in `docs/L2/skills-runtime.md` | Task 1 |

### Type consistency check

- `SkillProviderConfig` defined in Task 3, used in Task 3 tests ✓
- `progressive?: boolean` on `SkillInjectorConfig` defined and used in Task 5 ✓
- `generateAvailableSkillsBlock(skills: readonly SkillComponent[])` — `SkillComponent` imported from `@koi/core` already in `middleware.ts` ✓
- `skillMetadataToComponent(metadata: SkillMetadata)` — `SkillMetadata` already imported in `provider.ts` ✓
- `attachEager` / `attachProgressive` — both return `Promise<AttachResult>`, matching `attach` contract ✓

### Placeholder scan

None found — all code blocks are complete and compilable.
