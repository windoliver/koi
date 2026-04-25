export interface RetryConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterMs: number;
}

export function computeBackoff(attempt: number, config: RetryConfig): number {
  const exp = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
  const jitter = Math.random() * config.jitterMs;
  return exp + jitter;
}
