/**
 * Behavioral instructions for the memory skill.
 *
 * Injected into agents via SkillComponent so the LLM knows
 * when and how to use its memory tools.
 *
 * `generateMemorySkillContent(baseDir)` produces a dynamic version that
 * includes the on-disk storage path. The static `MEMORY_SKILL_CONTENT`
 * constant is kept for backward compatibility (no path info).
 */

export function generateMemorySkillContent(baseDir: string): string {
  return `## Memory Management

You have long-term memory. Use it proactively — you are responsible for deciding
what to remember. Memory persists across sessions on disk with automatic decay
and deduplication.

### Storage location

Your memory is stored at: \`${baseDir}\`

On-disk structure:
\`\`\`
${baseDir}/
├── entities/
│   └── <entity-slug>/
│       ├── items.json      # atomic facts (JSON array)
│       └── summary.md      # auto-generated summary (hot + warm facts)
└── sessions/
    └── YYYY-MM-DD.md       # daily session logs
\`\`\`

Each entity (person, project, concept) gets its own directory. Facts are stored
as structured JSON with category, related entities, timestamps, and access stats.

### Tools

- **memory_store**: Save an atomic fact with category and related entities
- **memory_recall**: Search memories by query. Uses semantic search (via @koi/search) when available, falls back to recency-based retrieval. Returns results with tier (hot/warm/cold) and decay score.
- **memory_search**: Browse what you know about a specific entity, or list all known entities

### When to store

- **Preferences**: "I prefer dark mode", "Use concise answers", "Always write in English"
- **Relationships**: "Alice is CTO at Acme Corp", "Bob reports to Alice"
- **Decisions**: "Chose PostgreSQL over MongoDB for project X", "Using JWT not sessions"
- **Milestones**: "API rewrite completed Feb 2026", "v2.0 launched"
- **Context**: "Project X uses React + TypeScript", "Deploy target is AWS"
- **Corrections**: When you learn something that contradicts a stored fact, store the correction — the old fact auto-supersedes

### When NOT to store

- Greetings, small talk, or trivial messages
- Temporary queries ("what time is it", "convert 5kg to lbs")
- Information already stored — tools auto-deduplicate, but avoid redundant calls
- Verbatim conversation transcripts — store the extracted fact, not the raw dialogue

### How to store

- **One atomic fact per call** — not paragraphs. "Alice prefers TypeScript" is good. A 5-sentence summary is bad.
- **Always include related_entities** — this creates cross-references between people, projects, and concepts. Use lowercase kebab-case: "alice", "project-x", "acme-corp".
- **Use descriptive categories**: "preference", "relationship", "decision", "milestone", "context", "correction"

### How to recall

- **At conversation start**: recall context about the user or topic to personalize the session
- **When user references past work**: recall relevant project/person facts before answering
- **Use tier filter** when you only need recent facts (tier: "hot") vs. full history (tier: "all")
- **Results are ranked**: hot facts (recent, frequently accessed) appear first. Cold facts still exist but may need explicit search.

### Decay tiers

Facts automatically decay based on recency:
- **Hot** (recent): prioritized in recall, appears in entity summaries
- **Warm** (weeks old): still accessible, lower priority. Frequently accessed facts (10+ accesses) resist decay and stay warm.
- **Cold** (months old): preserved on disk but excluded from summaries

Accessing a cold fact through recall warms it back up.
`;
}

/** Static fallback — no baseDir info. Use generateMemorySkillContent(baseDir) when possible. */
export const MEMORY_SKILL_CONTENT: string = generateMemorySkillContent("<memory-base-dir>");
