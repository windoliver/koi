/**
 * Skill component for Context Hub tools — teaches agents documentation lookup patterns.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const CONTEXT_HUB_SKILL_NAME = "context-hub" as const;

/**
 * Markdown content teaching agents Context Hub usage patterns.
 * Injected into the agent's context alongside the tool descriptors.
 */
export const CONTEXT_HUB_SKILL_CONTENT: string = `
# Context Hub — curated API documentation for agents

## Overview

Two tools are available: \`chub_search\` finds relevant API documentation by keyword,
and \`chub_get\` fetches the full documentation page. Together they give you access to
curated, community-maintained API docs that are more accurate than guessing from training data.

## When to use Context Hub

- **Before writing API integration code**: search for the API first — the docs may cover
  exact function signatures, required parameters, and common pitfalls
- **When you are unsure about an API**: if you are about to guess at an endpoint URL,
  parameter name, or return type, check Context Hub first
- **When the user mentions a specific API or SDK**: proactively search to get accurate,
  up-to-date documentation
- **After getting an API error**: the docs may explain the error code or required headers

## When NOT to use Context Hub

- **Standard library APIs**: do not search for built-in language features (e.g., Array.map,
  os.path) — your training data is sufficient
- **Internal/private APIs**: Context Hub only has public, community-contributed docs
- **Non-API questions**: Context Hub is for API docs, not general programming concepts

## Workflow patterns

### API integration workflow
1. \`chub_search\` with the API name (e.g., "stripe payments")
2. Review search results — check \`source\` field ("official" > "maintainer" > "community")
3. Check \`languages\` field to pick the right variant for the user's language
4. \`chub_get\` with the doc ID and language (e.g., id: "stripe/payments", language: "python")
5. Use the retrieved documentation to write accurate integration code

### Language variant selection
- Search results include available languages and their versions
- Always specify the language matching the user's codebase
- If the exact language is not available, check if a similar one exists (e.g., "typescript"
  docs may cover "javascript" usage)
- If no language is specified and multiple exist, \`chub_get\` will tell you the available
  options — just pick the right one and retry

### Persisting high-value docs (advanced)
If a doc proves especially useful and the agent has forge capabilities:
1. Fetch the doc with \`chub_get\`
2. Call \`forge_skill\` with the doc content as the body
3. The doc becomes a locally cached skill, available without future CDN fetches

## Error handling

| Code         | Meaning                                    | What to do                                       |
|--------------|--------------------------------------------|--------------------------------------------------|
| VALIDATION   | Bad argument or registry schema mismatch   | Fix the argument and retry; if "schema mismatch", report to operator |
| NOT_FOUND    | Doc ID, language, or version not available | Check the ID from search results; error message lists available options |
| TIMEOUT      | CDN request timed out                      | Try again — CDN may be slow                      |
| EXTERNAL     | Cannot reach Context Hub CDN               | CDN is down — try again later or skip            |

## Best practices

- **Search broadly, then narrow**: start with a general query like "stripe", then refine
  based on results (e.g., "stripe subscriptions")
- **Prefer official sources**: results with \`source: "official"\` are maintained by the
  API provider and most likely to be accurate
- **Check lastUpdated**: older docs may be outdated — use the date to assess reliability
- **Do not fetch blindly**: always search first — fetching a nonexistent ID wastes a tool call
`.trim();

/**
 * Pre-built SkillComponent for Context Hub usage guidance.
 * Attached automatically by createContextHubProvider alongside the tools.
 */
export const CONTEXT_HUB_SKILL: SkillComponent = {
  name: CONTEXT_HUB_SKILL_NAME,
  description:
    "When to search Context Hub for API docs, language variant selection, error recovery, and forge persistence pattern",
  content: CONTEXT_HUB_SKILL_CONTENT,
  tags: ["documentation", "api", "context-hub", "search"],
} as const satisfies SkillComponent;
