/**
 * Constants for @koi/tools-web — tool names, operations, trust tiers, and system prompt.
 */

/** All web operation names. */
export const OPERATIONS = ["fetch", "search"] as const;

export type WebOperation = (typeof OPERATIONS)[number];

/** Default tool name prefix for web tools. */
export const DEFAULT_PREFIX = "web" as const;

/** All web operations are read-only. */
export const READ_OPERATIONS: readonly WebOperation[] = OPERATIONS;

/**
 * System prompt guidance for agents using web tools.
 *
 * Include this in your agent's system prompt or koi.yaml `instructions` field
 * to prime the agent with web tool best practices.
 */
export const WEB_SYSTEM_PROMPT: string = `
## Web tools — best practices

When using web tools, follow these guidelines:

1. **Fetch** — use \`web_fetch\` to retrieve content from a specific URL.
   - The response body is truncated to ~50KB by default.
   - HTML content is returned as-is; parse it yourself if needed.
   - Set an appropriate timeout for slow endpoints.
   - Respects redirects automatically.

2. **Search** — use \`web_search\` to find information on the web.
   - Provide a clear, specific search query.
   - Results include title, URL, and snippet.
   - Use \`max_results\` to limit the number of results (default: 5).
   - Follow up with \`web_fetch\` on interesting URLs for full content.

## Error handling

| Code           | Meaning                  | What to do                        |
|----------------|--------------------------|-----------------------------------|
| VALIDATION     | Bad argument             | Fix the argument and retry        |
| TIMEOUT        | Request timed out        | Increase timeout or try later     |
| EXTERNAL       | Network or server error  | Check URL and retry (retryable)   |
| VALIDATION     | Search backend missing   | Configure searchFn in executor    |
`.trim();
