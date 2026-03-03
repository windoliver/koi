/**
 * Skill component for the web tools — teaches agents web fetching and search patterns.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const WEB_SKILL_NAME = "web" as const;

/**
 * Markdown content teaching agents web tool usage patterns.
 * Injected into the agent's context alongside the tool descriptors.
 */
export const WEB_SKILL_CONTENT: string = `
# Web Tools — fetching and searching the web

## Overview

Two tools are available: \`web_fetch\` retrieves content from a URL, and \`web_search\`
queries a search engine for results. Together they let you access external information,
verify claims, and gather data from public web resources.

## When to use web_fetch

- **Retrieving specific content**: you have a URL and need its content (docs, APIs, pages)
- **API calls**: making HTTP requests to REST/GraphQL endpoints
- **Verification**: confirming that a URL is valid and accessible
- **Content conversion**: fetching HTML and getting it back as clean markdown or text

## When to use web_search

- **Discovery**: finding URLs, documentation, or resources on a topic
- **Current information**: checking for recent events, releases, or changes
- **Comparison**: gathering multiple sources to cross-reference information
- **Unknown URLs**: when you do not have a specific URL but know what you are looking for

## When NOT to use web tools

- **Local files**: use filesystem tools for files on disk — web tools are for external URLs
- **Private/internal URLs**: \`web_fetch\` blocks private IPs and internal networks (SSRF protection)
- **Large downloads**: response bodies are truncated to ~50K characters — do not fetch
  large binary files or datasets
- **Authenticated endpoints**: these tools do not handle cookies, sessions, or OAuth flows —
  only use them for public or API-key-authenticated endpoints (pass keys via headers)

## Workflow patterns

### Research workflow
1. \`web_search\` to find relevant URLs
2. \`web_fetch\` to retrieve the most promising results
3. Synthesize findings from multiple sources

### API integration
1. \`web_fetch\` with appropriate method (GET/POST/PUT/DELETE)
2. Pass headers for authentication (API keys, bearer tokens)
3. Parse the JSON response and extract needed data

### Content extraction
1. \`web_fetch\` the target URL
2. Choose format: \`markdown\` for readable content, \`text\` for plain extraction
3. Process the converted content

## Best practices

- **Rate limiting awareness**: do not call web_fetch in rapid succession against the
  same domain — space requests out or batch them
- **Validate URLs**: ensure URLs are well-formed before fetching — malformed URLs waste
  a tool call
- **Handle failures gracefully**: URLs may be down, rate-limited, or return errors —
  check the response status and have a fallback plan
- **Prefer search then fetch**: when unsure of the exact URL, search first rather than
  guessing URLs

## Error handling

- **Timeout**: the request took too long — the server may be slow or the content too large.
  Try again with a shorter timeout or a different URL
- **Blocked URL**: the URL points to a private/internal network — this is an SSRF protection.
  Only public URLs are allowed
- **HTTP errors (4xx/5xx)**: the server returned an error — check the status code for details
  (404 = not found, 429 = rate limited, 500 = server error)
- **Empty response**: the page may require JavaScript rendering — web_fetch retrieves
  static HTML only, not dynamically rendered content
`.trim();

/**
 * Pre-built SkillComponent for web tool usage guidance.
 * Attached automatically by createWebProvider alongside the tools.
 */
export const WEB_SKILL: SkillComponent = {
  name: WEB_SKILL_NAME,
  description:
    "When to fetch vs search, handling pagination and rate limiting, SSRF awareness, and content conversion",
  content: WEB_SKILL_CONTENT,
  tags: ["web", "fetch", "search", "http"],
} as const satisfies SkillComponent;
