import type { TranscriptEntry } from "@koi/core";

export interface Turn {
  readonly index: number;
  readonly entries: readonly TranscriptEntry[];
}

export function groupTurns(entries: readonly TranscriptEntry[]): readonly Turn[] {
  const turns: Turn[] = [];
  let current: TranscriptEntry[] = [];
  let index = 0;

  for (const e of entries) {
    const isBoundary = e.role === "user" || e.role === "compaction";
    if (isBoundary && current.length > 0) {
      turns.push({ index: index++, entries: current });
      current = [];
    }
    current.push(e);
  }
  if (current.length > 0) {
    turns.push({ index: index++, entries: current });
  }
  return turns;
}

export function turnsToEntryRange(
  turns: readonly Turn[],
  fromTurn: number,
  toTurn: number,
): readonly TranscriptEntry[] {
  if (fromTurn < 0 || toTurn < fromTurn || toTurn >= turns.length) {
    return [];
  }
  const out: TranscriptEntry[] = [];
  for (let i = fromTurn; i <= toTurn; i++) {
    const t = turns[i];
    if (!t) continue;
    for (const e of t.entries) out.push(e);
  }
  return out;
}
