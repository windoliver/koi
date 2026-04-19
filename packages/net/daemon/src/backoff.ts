export interface BackoffConfig {
  readonly baseMs: number;
  readonly ceilingMs: number;
}

export function computeBackoff(attempt: number, config: BackoffConfig): number {
  const raw = config.baseMs * 2 ** attempt;
  return Math.min(raw, config.ceilingMs);
}
