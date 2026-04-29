const STOPWORDS = new Set(["a", "an", "the", "to", "for", "in", "on", "of", "and", "or"]);

export function buildKeywordPatterns(objectives: readonly string[]): readonly RegExp[] {
  const words = new Set<string>();
  for (const obj of objectives) {
    for (const t of obj.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length > 2 && !STOPWORDS.has(t)) words.add(t);
    }
  }
  return [...words].map((w) => new RegExp(w, "i"));
}
