/**
 * Behavioral instructions for the memory skill.
 *
 * Injected into agents via SkillComponent so the LLM knows
 * when and how to use its memory tools.
 */

/** Generate memory tool skill content with an optional base directory. */
export function generateMemoryToolSkillContent(baseDir?: string | undefined): string {
  const storageSection =
    baseDir !== undefined
      ? `
### Storage location

Your memory is stored at: \`${baseDir}\`
`
      : "";

  return `## Memory Management

You have long-term memory. Use it proactively — you are responsible for deciding
what to remember. Memory persists across sessions with automatic deduplication.
${storageSection}
### Tools

- **memory_store**: Save a memory record with name, description, type, and content. Checks for duplicates by name and type — use \`force: true\` to overwrite.
- **memory_recall**: Retrieve memories relevant to a query or topic. Returns results ranked by relevance. Supports tier filtering and causal graph expansion.
- **memory_search**: Search memories by keyword, type, or date range. All inputs are optional — an empty search returns all memories.
- **memory_delete**: Remove a stale or incorrect memory by ID.

### Memory types

| Type | Purpose | Examples |
|------|---------|---------|
| \`user\` | Role, preferences, expertise | "prefers TypeScript", "senior engineer" |
| \`feedback\` | Corrections AND validated approaches | "don't mock the DB", "single PR was right call" |
| \`project\` | Ongoing work, deadlines, decisions | "merge freeze March 5", "auth rewrite for compliance" |
| \`reference\` | Pointers to external systems | "bugs tracked in Linear INGEST project" |

### When to store

- **Preferences**: "I prefer dark mode", "Use concise answers"
- **Decisions**: "Chose PostgreSQL over MongoDB for project X"
- **Corrections**: When you learn something contradicts a stored fact
- **Milestones**: "API rewrite completed Feb 2026"
- **Context**: "Project X uses React + TypeScript"

### When NOT to store

- Greetings, small talk, or trivial messages
- Temporary queries ("what time is it")
- Information already stored — the tool auto-deduplicates
- Code patterns or architecture derivable from reading the codebase

### How to store

- Use a clear, specific **name** that describes the memory
- Write a one-line **description** — this is used to decide relevance in future conversations
- Choose the right **type** (user, feedback, project, reference)
- **Content** should include the fact, then a \`**Why:**\` and \`**How to apply:**\` line for feedback/project types

### How to recall

- At conversation start: recall context about the user or topic
- When user references past work: recall relevant facts before answering
- Use **tier filter** for recent facts only (\`tier: "hot"\`) vs. full history (\`tier: "all"\`)

### Decay tiers

Facts automatically decay based on recency:
- **Hot** (recent): prioritized in recall
- **Warm** (weeks old): still accessible, lower priority
- **Cold** (months old): preserved but excluded from summaries

Accessing a cold fact through recall warms it back up.
`;
}

/** Static fallback — no baseDir info. */
export const MEMORY_TOOL_SKILL_CONTENT: string = generateMemoryToolSkillContent();
