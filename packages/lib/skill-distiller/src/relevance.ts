import type { DistillationRecord } from "./types.js";

const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "on",
  "with",
  "by",
  "is",
  "are",
  "be",
  "as",
  "it",
  "this",
  "that",
  "i",
  "you",
  "we",
  "my",
  "your",
  "our",
]);

export function defaultTokenize(text: string): readonly string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  const parts = normalized.split(/\s+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length < 2) continue;
    if (STOPWORDS.has(part)) continue;
    out.push(part);
  }
  return out;
}

export interface RelevanceConfig {
  /** Override the default tokenizer. */
  readonly tokenize?: (text: string) => readonly string[];
  /** Weight added when a full trigger phrase appears as a substring of the query. Default 0.5. */
  readonly triggerPhraseBonus?: number;
}

export interface RankedSkill {
  readonly record: DistillationRecord;
  readonly score: number;
}

export interface RelevanceScorer {
  /** Single-record score in [0, 1+bonus]. Returns 0 when query has no tokens. */
  readonly score: (query: string, record: DistillationRecord) => number;
  /** Returns top-N records by descending score. Records with score 0 are excluded. */
  readonly rank: (
    query: string,
    records: readonly DistillationRecord[],
    topN?: number,
  ) => readonly RankedSkill[];
}

function recordCorpus(record: DistillationRecord): string {
  const { name, description, triggers } = record.draft;
  return `${name} ${description} ${triggers.join(" ")}`;
}

export function createRelevanceScorer(config: RelevanceConfig = {}): RelevanceScorer {
  const tokenize = config.tokenize ?? defaultTokenize;
  const phraseBonus = config.triggerPhraseBonus ?? 0.5;

  const scoreOne = (query: string, record: DistillationRecord): number => {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return 0;
    const docTokens = new Set(tokenize(recordCorpus(record)));
    if (docTokens.size === 0) return 0;
    let overlap = 0;
    for (const t of queryTokens) {
      if (docTokens.has(t)) overlap += 1;
    }
    const union = queryTokens.size + docTokens.size - overlap;
    const jaccard = union === 0 ? 0 : overlap / union;
    if (jaccard === 0) return 0;
    const lowerQuery = query.toLowerCase();
    let bonus = 0;
    for (const trigger of record.draft.triggers) {
      if (trigger.length === 0) continue;
      if (lowerQuery.includes(trigger.toLowerCase())) {
        bonus = phraseBonus;
        break;
      }
    }
    return jaccard + bonus;
  };

  return {
    score: scoreOne,
    rank: (
      query: string,
      records: readonly DistillationRecord[],
      topN?: number,
    ): readonly RankedSkill[] => {
      const ranked: RankedSkill[] = [];
      for (const record of records) {
        const s = scoreOne(query, record);
        if (s > 0) ranked.push({ record, score: s });
      }
      ranked.sort((a, b) => b.score - a.score);
      return topN === undefined ? ranked : ranked.slice(0, topN);
    },
  };
}
