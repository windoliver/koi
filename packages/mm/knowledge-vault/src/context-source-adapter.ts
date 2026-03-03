/**
 * Context source adapter for @koi/context integration.
 *
 * Returns a SourceResolver function that can be registered with the
 * context hydrator's `resolvers` Map under a custom source kind.
 *
 * Usage in L3 or application code:
 * ```ts
 * const resolvers = new Map([
 *   ["knowledge", createKnowledgeSourceResolver(vaultService)],
 * ]);
 * ```
 */

import type { Agent } from "@koi/core";

import type { VaultService } from "./vault-service.js";

/**
 * A SourceResolver-compatible function type.
 *
 * Matches the SourceResolver signature from @koi/context:
 * `(source: ContextSource, agent: Agent) => SourceResult | Promise<SourceResult>`
 *
 * We define a local interface to avoid importing @koi/context (L2→L2 violation).
 */
export interface KnowledgeSourceResult {
  readonly label: string;
  readonly content: string;
  readonly tokens: number;
  readonly source: { readonly kind: string };
}

export type KnowledgeSourceResolver = (
  source: { readonly kind: string; readonly query?: string; readonly label?: string },
  agent: Agent,
) => Promise<KnowledgeSourceResult>;

/**
 * Create a SourceResolver that queries the vault service.
 *
 * The resolver expects source objects with `kind: "knowledge"` and
 * an optional `query` field. If no query is provided, it returns
 * an empty result.
 */
export function createKnowledgeSourceResolver(service: VaultService): KnowledgeSourceResolver {
  return async (
    source: { readonly kind: string; readonly query?: string; readonly label?: string },
    _agent: Agent,
  ): Promise<KnowledgeSourceResult> => {
    const query = source.query ?? "";
    const label = source.label ?? "Knowledge Vault";

    if (query === "") {
      return {
        label,
        content: "",
        tokens: 0,
        source: { kind: source.kind },
      };
    }

    const docs = await service.query(query);
    const content = docs.map((doc) => `## ${doc.title}\n\n${doc.content}`).join("\n\n---\n\n");

    const tokens = Math.ceil(content.length / 4);

    return {
      label,
      content,
      tokens,
      source: { kind: source.kind },
    };
  };
}
