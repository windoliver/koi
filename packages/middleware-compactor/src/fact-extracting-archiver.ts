/**
 * Fact-extracting compaction archiver.
 *
 * Extracts structured facts from messages before they are replaced by
 * a summary, persisting them to a MemoryComponent so critical information
 * survives compaction via the tiered persistence layer.
 */

import type { MemoryComponent } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { FactExtractionConfig } from "./fact-extraction.js";
import { extractFacts, resolveFactExtractionConfig } from "./fact-extraction.js";
import type { CompactionArchiver } from "./types.js";

/**
 * Creates an archiver that extracts structured facts from messages
 * and stores them via the provided MemoryComponent before compaction
 * discards the originals.
 *
 * Designed to be passed as `config.archiver` to `createLlmCompactor`
 * or `createCompactorMiddleware`.
 */
export function createFactExtractingArchiver(
  memory: MemoryComponent,
  config?: Partial<FactExtractionConfig>,
): CompactionArchiver {
  const resolved = resolveFactExtractionConfig(config);

  return {
    async archive(messages: readonly InboundMessage[], _summary: string): Promise<void> {
      const facts = extractFacts(messages, resolved);
      if (facts.length === 0) return;

      // Parallel storage — memory-fs write queue handles per-entity serialization
      await Promise.all(
        facts.map((fact) =>
          memory.store(fact.text, {
            category: fact.category,
            relatedEntities: [...fact.entities],
            reinforce: resolved.reinforce ?? true,
          }),
        ),
      );
    },
  };
}
